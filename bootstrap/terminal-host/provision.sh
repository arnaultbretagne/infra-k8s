#!/usr/bin/env bash
# Provision the host side of terminal.bretagne.dev (ADR 0023) — idempotent.
#
# Why host units and not a pod: the terminal must give the SAME low-level host access as
# an operator session (`su - dev` + sudo), not a container's own namespaces. So `ttyd`
# runs on the host, bound to loopback, and a host `oauth2-proxy` (Pocket-ID admin gate) is
# the ONLY thing exposed — and only to the pod CIDR (firewall). The cluster owns just the
# edge glue (apps/terminal: Service + EndpointSlice + HTTPRoute).
#
# Run as root from the repo root:  sudo bootstrap/terminal-host/provision.sh
set -euo pipefail

TTYD_VER=1.7.7
O2P_VER=7.7.1
AGE_KEY=/root/.config/sops/age/keys.txt
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

echo "== binaries =="
if [ ! -x /usr/local/bin/ttyd ]; then
  curl -fsSL -o /tmp/ttyd https://github.com/tsl0922/ttyd/releases/download/${TTYD_VER}/ttyd.x86_64
  install -m 0755 /tmp/ttyd /usr/local/bin/ttyd
fi
if [ ! -x /usr/local/bin/oauth2-proxy ]; then
  curl -fsSL -o /tmp/o2p.tgz https://github.com/oauth2-proxy/oauth2-proxy/releases/download/v${O2P_VER}/oauth2-proxy-v${O2P_VER}.linux-amd64.tar.gz
  tar xzf /tmp/o2p.tgz -C /tmp
  install -m 0755 /tmp/oauth2-proxy-v${O2P_VER}.linux-amd64/oauth2-proxy /usr/local/bin/oauth2-proxy
fi

echo "== env file (secrets from SOPS + static OIDC config) =="
eval "$(SOPS_AGE_KEY_FILE=$AGE_KEY sops --decrypt "$HERE/oauth2-proxy.secret.yaml" \
  | awk '/OAUTH2_PROXY_/{gsub(/"/,"",$2); print "export "$1$2}' | sed 's/: /=/')"
umask 077
cat > /etc/terminal-oauth2-proxy.env <<EOF
OAUTH2_PROXY_PROVIDER=oidc
OAUTH2_PROXY_OIDC_ISSUER_URL=https://id.bretagne.dev
OAUTH2_PROXY_CLIENT_ID=${OAUTH2_PROXY_CLIENT_ID}
OAUTH2_PROXY_CLIENT_SECRET=${OAUTH2_PROXY_CLIENT_SECRET}
OAUTH2_PROXY_COOKIE_SECRET=${OAUTH2_PROXY_COOKIE_SECRET}
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
chmod 600 /etc/terminal-oauth2-proxy.env

echo "== systemd units =="
install -m 0644 "$HERE/ttyd-terminal.service" /etc/systemd/system/ttyd-terminal.service
install -m 0644 "$HERE/terminal-oauth2-proxy.service" /etc/systemd/system/terminal-oauth2-proxy.service
systemctl daemon-reload
systemctl enable --now ttyd-terminal.service
systemctl enable --now terminal-oauth2-proxy.service

echo "== firewall: pod CIDR -> host oauth2-proxy:4180 =="
if ! grep -q "tcp dport 4180 accept" /etc/nftables.conf; then
  sed -i '/ip saddr 10.244.0.0\/16 tcp dport 10250 accept/a\
\
    # terminal.bretagne.dev web shell: Traefik (pod net) -> host oauth2-proxy:4180.\
    ip saddr 10.244.0.0/16 tcp dport 4180 accept' /etc/nftables.conf
  nft -f /etc/nftables.conf
fi

echo "== done. Verify: curl -s localhost:4180/ping (OK); ttyd is loopback-only. =="
