#!/usr/bin/env bash
# Provision the host side of terminal.bretagne.dev (ADR 0023).
# Called by bootstrap/bootstrap.sh and safe to re-run.
set -euo pipefail

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

TTYD_VERSION="${TTYD_VERSION:-1.7.7}"
OAUTH2_PROXY_VERSION="${OAUTH2_PROXY_VERSION:-7.7.1}"
AGE_KEY="/root/.config/sops/age/keys.txt"
HERE="$(cd "$(dirname "$0")" && pwd)"

log() { printf '    -> %s\n' "$*"; }
fail() { printf '    terminal provisioning failed: %s\n' "$*" >&2; exit 1; }

verify_sha256() {
  local dir="$1" manifest="$2" asset="$3" expected
  expected=$(awk -v target="$asset" '
    NF == 1 { print $1; exit }
    { if ($2 == target) { print $1; exit } }
  ' "$dir/$manifest")
  [ -n "$expected" ] || return 1
  printf '%s  %s\n' "$expected" "$asset" | (cd "$dir" && sha256sum -c -)
}

[ "$(id -u)" -eq 0 ] || fail "must run as root"
[ -f "$AGE_KEY" ] || fail "missing AGE key: $AGE_KEY"

case "$(dpkg --print-architecture)" in
  amd64)
    TTYD_ARCH=x86_64
    OAUTH2_PROXY_ARCH=amd64
    ;;
  arm64)
    TTYD_ARCH=aarch64
    OAUTH2_PROXY_ARCH=arm64
    ;;
  *) fail "unsupported architecture: $(dpkg --print-architecture)" ;;
esac

log "dedicated dev account"
if id dev >/dev/null 2>&1; then
  dev_home=$(getent passwd dev | awk -F: '{ print $6 }')
  dev_shell=$(getent passwd dev | awk -F: '{ print $7 }')
  [ "$dev_home" = /home/dev ] || fail "existing dev user has unexpected home: $dev_home"
  [ "$dev_shell" = /bin/bash ] || fail "existing dev user has unexpected shell: $dev_shell"
else
  useradd --create-home --user-group --shell /bin/bash dev
fi
install -d -o dev -g dev -m 0750 /home/dev

sudoers_tmp=$(mktemp)
printf '%s\n' 'dev ALL=(ALL:ALL) NOPASSWD: ALL' > "$sudoers_tmp"
visudo -cf "$sudoers_tmp" >/dev/null || fail "invalid sudoers rule for dev"
install -o root -g root -m 0440 "$sudoers_tmp" /etc/sudoers.d/90-dev-nopasswd
rm -f "$sudoers_tmp"
sudo -n -u dev sudo -n true || fail "dev passwordless sudo verification failed"
log "dev exists with validated NOPASSWD sudo"

log "ttyd ${TTYD_VERSION}"
if command -v ttyd >/dev/null 2>&1 && ttyd --version 2>&1 | grep -q "$TTYD_VERSION"; then
  log "ttyd already installed"
else
  ttyd_tmp=$(mktemp -d)
  ttyd_asset="ttyd.${TTYD_ARCH}"
  ttyd_url="https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}"
  curl -fsSLo "$ttyd_tmp/$ttyd_asset" "$ttyd_url/$ttyd_asset"
  curl -fsSLo "$ttyd_tmp/SHA256SUMS" "$ttyd_url/SHA256SUMS"
  verify_sha256 "$ttyd_tmp" SHA256SUMS "$ttyd_asset" \
    || fail "ttyd checksum verification failed"
  install -o root -g root -m 0755 "$ttyd_tmp/$ttyd_asset" /usr/local/bin/ttyd
  rm -rf "$ttyd_tmp"
fi

log "oauth2-proxy ${OAUTH2_PROXY_VERSION}"
if command -v oauth2-proxy >/dev/null 2>&1 \
  && oauth2-proxy --version 2>&1 | grep -q "v${OAUTH2_PROXY_VERSION}"; then
  log "oauth2-proxy already installed"
else
  oauth_tmp=$(mktemp -d)
  oauth_dir="oauth2-proxy-v${OAUTH2_PROXY_VERSION}.linux-${OAUTH2_PROXY_ARCH}"
  oauth_asset="${oauth_dir}.tar.gz"
  oauth_checksum="${oauth_asset}-sha256sum.txt"
  oauth_url="https://github.com/oauth2-proxy/oauth2-proxy/releases/download/v${OAUTH2_PROXY_VERSION}"
  curl -fsSLo "$oauth_tmp/$oauth_asset" "$oauth_url/$oauth_asset"
  curl -fsSLo "$oauth_tmp/$oauth_checksum" "$oauth_url/$oauth_checksum"
  verify_sha256 "$oauth_tmp" "$oauth_checksum" "$oauth_asset" \
    || fail "oauth2-proxy checksum verification failed"
  tar -xzf "$oauth_tmp/$oauth_asset" -C "$oauth_tmp"
  install -o root -g root -m 0755 "$oauth_tmp/$oauth_dir/oauth2-proxy" \
    /usr/local/bin/oauth2-proxy
  rm -rf "$oauth_tmp"
fi

log "decrypt terminal OIDC configuration"
decrypt_field() {
  SOPS_AGE_KEY_FILE="$AGE_KEY" sops --decrypt \
    --extract "[\"stringData\"][\"$1\"]" "$HERE/oauth2-proxy.secret.yaml"
}

client_id=$(decrypt_field OAUTH2_PROXY_CLIENT_ID)
client_secret=$(decrypt_field OAUTH2_PROXY_CLIENT_SECRET)
cookie_secret=$(decrypt_field OAUTH2_PROXY_COOKIE_SECRET)
[ -n "$client_id" ] && [ -n "$client_secret" ] && [ -n "$cookie_secret" ] \
  || fail "decrypted terminal OIDC configuration is incomplete"

env_tmp=$(mktemp)
trap 'test ! -e "$env_tmp" || rm -f "$env_tmp"' EXIT
chmod 0600 "$env_tmp"
cat > "$env_tmp" <<EOF
OAUTH2_PROXY_PROVIDER=oidc
OAUTH2_PROXY_OIDC_ISSUER_URL=https://id.bretagne.dev
OAUTH2_PROXY_CLIENT_ID=${client_id}
OAUTH2_PROXY_CLIENT_SECRET=${client_secret}
OAUTH2_PROXY_COOKIE_SECRET=${cookie_secret}
OAUTH2_PROXY_REDIRECT_URL=https://terminal.bretagne.dev/oidc/callback
OAUTH2_PROXY_PROXY_PREFIX=/oidc
OAUTH2_PROXY_UPSTREAMS=http://127.0.0.1:7681
OAUTH2_PROXY_HTTP_ADDRESS=0.0.0.0:4180
OAUTH2_PROXY_SCOPE=openid email profile groups
OAUTH2_PROXY_OIDC_GROUPS_CLAIM=groups
OAUTH2_PROXY_ALLOWED_GROUPS=admin
OAUTH2_PROXY_EMAIL_DOMAINS=*
OAUTH2_PROXY_COOKIE_SECURE=true
OAUTH2_PROXY_COOKIE_DOMAINS=terminal.bretagne.dev
OAUTH2_PROXY_WHITELIST_DOMAINS=terminal.bretagne.dev
OAUTH2_PROXY_REVERSE_PROXY=true
OAUTH2_PROXY_SKIP_PROVIDER_BUTTON=true
OAUTH2_PROXY_INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL=true
EOF
install -o root -g root -m 0600 "$env_tmp" /etc/terminal-oauth2-proxy.env
rm -f "$env_tmp"
trap - EXIT
unset client_id client_secret cookie_secret

log "systemd units"
install -o root -g root -m 0644 "$HERE/ttyd-terminal.service" \
  /etc/systemd/system/ttyd-terminal.service
install -o root -g root -m 0644 "$HERE/terminal-oauth2-proxy.service" \
  /etc/systemd/system/terminal-oauth2-proxy.service
systemctl daemon-reload
systemctl enable --now ttyd-terminal.service
systemctl is-active --quiet ttyd-terminal.service || fail "ttyd service failed to start"

# oauth2-proxy performs OIDC discovery at startup. Before DNS cutover, the old
# issuer may deliberately be offline; enable the restart loop without making
# that expected transitional state fail the whole cluster bootstrap.
systemctl enable terminal-oauth2-proxy.service >/dev/null
systemctl restart terminal-oauth2-proxy.service >/dev/null 2>&1 || true

grep -q 'ip saddr 10.244.0.0/16 tcp dport 4180 accept' /etc/nftables.conf \
  || fail "host firewall is missing the pod CIDR -> terminal:4180 rule"

log "terminal host provisioned; oauth2-proxy will become active when Pocket-ID is reachable"
