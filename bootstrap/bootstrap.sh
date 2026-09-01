#!/usr/bin/env bash
# ============================================================================
# infra-k8s bootstrap
# Bootstraps a k0s + Flux cluster on a fresh Debian VPS.
# Idempotent — safe to re-run.
#
# Required input (env var):
#   PUBLIC_IP — static IPv4 address assigned to this node (API address/SAN)
# ============================================================================

set -euo pipefail

# sudo may preserve a user PATH without the Debian administrative directories.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BOOTSTRAP_DIR="$REPO_DIR/bootstrap"

# ─── Configuration ────────────────────────────────────────────────────
K0S_VERSION="v1.35.2+k0s.0"
HELM_VERSION="v3.20.2"
FLUX_VERSION="2.8.3"
SOPS_VERSION="3.9.4"
RUNSC_VERSION="release-20260622.0"
TTYD_VERSION="1.7.7"
OAUTH2_PROXY_VERSION="7.7.1"

AGE_KEY_FILE="/root/.config/sops/age/keys.txt"
DEPLOY_KEY_FILE="/root/.ssh/infra-k8s-deploy"
AES_KEY_FILE="/root/.config/k0s/encryption-key"

REPO_URL="ssh://git@github.com/arnaultbretagne/infra-k8s.git"
CLUSTER_PATH="clusters/bretagne"

# ─── Helpers ──────────────────────────────────────────────────────────
log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '    \033[1;33m⚠ %s\033[0m\n' "$*"; }
fail() { printf '    \033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

wait_for() {
  local desc="$1"; shift
  local tries=0
  until "$@" &>/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -ge 60 ] && fail "$desc: timeout after 120s"
    sleep 2
  done
  ok "$desc"
}

verify_sha256() {
  local dir="$1" manifest="$2" asset="$3" expected
  expected=$(awk -v target="$asset" '
    NF == 1 { print $1; exit }
    {
      name = $2
      sub(/^\*/, "", name)
      if (name == target) { print $1; exit }
    }
  ' "$dir/$manifest")
  [ -n "$expected" ] || return 1
  printf '%s  %s\n' "$expected" "$asset" | (cd "$dir" && sha256sum -c -)
}

# ─── Preflight ────────────────────────────────────────────────────────
log "Preflight checks"

[ "$(id -u)" -eq 0 ] || fail "Must run as root"

for cmd in apt-get awk base64 bash chmod chown curl date dd dpkg fallocate getent git \
  grep groupadd head id install ip logger mkdir mktemp mkswap modprobe mv nft ping rm \
  sed sha256sum sha512sum sleep sshd ssh-keygen ss sudo swapon sysctl systemctl \
  systemd-run tar tc timedatectl timeout touch useradd visudo wc; do
  command -v "$cmd" &>/dev/null || fail "Missing required command: $cmd"
done

[ -f "$AGE_KEY_FILE" ]        || fail "AGE_KEY_FILE not found: $AGE_KEY_FILE"
[ -f "$DEPLOY_KEY_FILE" ]     || fail "DEPLOY_KEY_FILE not found: $DEPLOY_KEY_FILE"
[ -n "${PUBLIC_IP:-}" ]       || fail "PUBLIC_IP not set (must be the node's static IPv4 address)"

# PUBLIC_IP is deliberately explicit: a multi-interface/VLAN host must never
# bootstrap against whichever address happens to be returned first.
if ! [[ "$PUBLIC_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  fail "PUBLIC_IP is not an IPv4 address: $PUBLIC_IP"
fi
if ! ip -4 -o addr show scope global | awk -v expected="$PUBLIC_IP" '
  { split($4, addr, "/"); if (addr[1] == expected) found = 1 }
  END { exit(found ? 0 : 1) }
'; then
  fail "PUBLIC_IP is not assigned to this host: $PUBLIC_IP"
fi
ok "Node/API IP: $PUBLIC_IP"

grep -q '^AGE-SECRET-KEY-1' "$AGE_KEY_FILE" \
  || fail "AGE_KEY_FILE does not contain an AGE secret key"
ssh-keygen -y -P '' -f "$DEPLOY_KEY_FILE" >/dev/null 2>&1 \
  || fail "DEPLOY_KEY_FILE is invalid or passphrase-protected"
ok "Secret key files are structurally valid"

[ "$(timedatectl show --property=NTPSynchronized --value 2>/dev/null)" = "yes" ] \
  || fail "System clock is not NTP-synchronized"
ok "System clock is NTP-synchronized"

# A re-run on an existing cluster legitimately finds Traefik on 443. A fresh
# bootstrap must not steal the port from an unrelated host service.
if ! command -v k0s &>/dev/null || ! k0s status &>/dev/null 2>&1; then
  if ss -H -ltn 'sport = :443' | grep -q .; then
    fail "TCP/443 is already in use on this fresh node"
  fi
fi
ok "TCP/443 is available for bootstrap"

# Validate the exact Git credential Flux will use before changing host state.
if ! git -c core.sshCommand="ssh -i $DEPLOY_KEY_FILE -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new" \
  ls-remote "$REPO_URL" HEAD >/dev/null 2>&1; then
  fail "Deploy key cannot read $REPO_URL"
fi
ssh-keygen -F github.com -f /root/.ssh/known_hosts >/dev/null 2>&1 \
  || fail "GitHub host key was not recorded in /root/.ssh/known_hosts"
ok "Flux deploy key can read the repository"

DEB_ARCH=$(dpkg --print-architecture)
case "$DEB_ARCH" in
  amd64) GVISOR_ARCH=x86_64 ;;
  arm64) GVISOR_ARCH=aarch64 ;;
  *) fail "Unsupported architecture: $DEB_ARCH" ;;
esac

K0S_ASSET="k0s-${K0S_VERSION}-${DEB_ARCH}"
K0S_RELEASE_URL="https://github.com/k0sproject/k0s/releases/download/${K0S_VERSION}"
HELM_ASSET="helm-${HELM_VERSION}-linux-${DEB_ARCH}.tar.gz"
HELM_RELEASE_URL="https://get.helm.sh"
FLUX_ASSET="flux_${FLUX_VERSION}_linux_${DEB_ARCH}.tar.gz"
FLUX_RELEASE_URL="https://github.com/fluxcd/flux2/releases/download/v${FLUX_VERSION}"
SOPS_ASSET="sops-v${SOPS_VERSION}.linux.${DEB_ARCH}"
SOPS_RELEASE_URL="https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}"
GVISOR_RELEASE_URL="https://storage.googleapis.com/gvisor/releases/release/${RUNSC_VERSION#release-}/${GVISOR_ARCH}"
TTYD_RELEASE_URL="https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}"
OAUTH2_PROXY_ASSET="oauth2-proxy-v${OAUTH2_PROXY_VERSION}.linux-${DEB_ARCH}.tar.gz"
OAUTH2_PROXY_RELEASE_URL="https://github.com/oauth2-proxy/oauth2-proxy/releases/download/v${OAUTH2_PROXY_VERSION}"

download_endpoints=(
  "$K0S_RELEASE_URL/$K0S_ASSET"
  "$K0S_RELEASE_URL/sha256sums.txt"
  "$HELM_RELEASE_URL/$HELM_ASSET"
  "$HELM_RELEASE_URL/$HELM_ASSET.sha256"
  "$FLUX_RELEASE_URL/$FLUX_ASSET"
  "$FLUX_RELEASE_URL/flux_${FLUX_VERSION}_checksums.txt"
  "$SOPS_RELEASE_URL/$SOPS_ASSET"
  "$SOPS_RELEASE_URL/sops-v${SOPS_VERSION}.checksums.txt"
  "$GVISOR_RELEASE_URL/runsc"
  "$GVISOR_RELEASE_URL/runsc.sha512"
  "$GVISOR_RELEASE_URL/containerd-shim-runsc-v1"
  "$GVISOR_RELEASE_URL/containerd-shim-runsc-v1.sha512"
  "$TTYD_RELEASE_URL/ttyd.${GVISOR_ARCH}"
  "$TTYD_RELEASE_URL/SHA256SUMS"
  "$OAUTH2_PROXY_RELEASE_URL/$OAUTH2_PROXY_ASSET"
  "$OAUTH2_PROXY_RELEASE_URL/$OAUTH2_PROXY_ASSET-sha256sum.txt"
)
for endpoint in "${download_endpoints[@]}"; do
  curl --fail --silent --show-error --location --head \
    --connect-timeout 10 --max-time 30 "$endpoint" >/dev/null \
    || fail "Required download endpoint is unreachable: $endpoint"
done
ok "Required download endpoints are reachable"

# ─── Phase 1: OS Hardening ───────────────────────────────────────────
log "Phase 1 — OS hardening"

# Firewall (nftables)
cat > /etc/nftables.conf <<'NFTEOF'
#!/usr/sbin/nft -f
flush ruleset

table inet firewall {
  chain input {
    type filter hook input priority 0; policy drop;

    # Established connections
    ct state established,related accept

    # Loopback (k8s internal traffic uses this)
    iif lo accept

    # SSH
    tcp dport 22 accept

    # HTTPS only. ACME uses DNS-01, so port 80 is intentionally closed.
    tcp dport 443 accept

    # K8s API — pod and service CIDRs only, blocked from internet
    ip saddr { 10.244.0.0/16, 10.96.0.0/12 } tcp dport 6443 accept

    # Kubelet — pods only
    ip saddr 10.244.0.0/16 tcp dport 10250 accept

    # terminal.bretagne.dev web shell (ADR 0023): Traefik (pod net) -> host
    # oauth2-proxy:4180. Pod CIDR only; ttyd itself is loopback-only.
    ip saddr 10.244.0.0/16 tcp dport 4180 accept

    # Cilium agent/operator/Hubble metrics (hostNetwork), scraped by Prometheus pods.
    ip saddr 10.244.0.0/16 tcp dport { 9962, 9963, 9965 } accept

    # ICMP
    ip protocol icmp accept
    ip6 nexthdr icmpv6 accept
  }
}
NFTEOF

nft -f /etc/nftables.conf
systemctl enable --now nftables 2>/dev/null
systemctl is-active --quiet nftables || fail "nftables failed to start"
ok "Firewall: 22/443 accepted — Kubernetes and metrics ports restricted to pod/service CIDRs"

# SSH hardening.
# GOTCHA: sshd reads sshd_config.d/*.conf in lexical order and keeps the FIRST value per
# keyword. cloud-init ships 50-cloud-init.conf with `PasswordAuthentication yes`, which WINS
# over a 99-* drop-in (50 < 99). So our hardening file alone is a no-op — we must also
# neutralise cloud-init's directive (both the live file and any future cloud-init re-run).
cat > /etc/ssh/sshd_config.d/99-bootstrap-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
ChallengeResponseAuthentication no
UsePAM yes
PubkeyAuthentication yes
EOF
chmod 600 /etc/ssh/sshd_config.d/99-bootstrap-hardening.conf

# Kill cloud-init's `PasswordAuthentication yes` at the source + prevent regeneration.
if [ -f /etc/ssh/sshd_config.d/50-cloud-init.conf ]; then
  sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config.d/50-cloud-init.conf
fi
mkdir -p /etc/cloud/cloud.cfg.d
echo 'ssh_pwauth: false' > /etc/cloud/cloud.cfg.d/99-disable-ssh-pwauth.cfg

# Validate before applying; reload (never restart) so a live SSH session is never dropped.
if sshd -t; then
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
  ok "SSH hardened: password auth disabled (incl. cloud-init override), root key-only"
else
  warn "sshd -t failed — SSH config NOT reloaded; review sshd_config.d drop-ins"
fi

# Fail2ban
apt-get update -qq
if systemctl is-active --quiet fail2ban 2>/dev/null; then
  ok "fail2ban already running"
else
  apt-get install -y -qq --no-install-recommends fail2ban
  systemctl enable --now fail2ban
  ok "fail2ban installed and enabled"
fi

# Automatic security updates.
# GOTCHA: installing + enabling the service is NOT enough — the apt-daily-upgrade
# timer only acts if APT::Periodic is configured. Without 20auto-upgrades, nothing
# is ever applied (the service reports "active" but patches nothing).
apt-get install -y -qq --no-install-recommends unattended-upgrades
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
# No automatic reboot (Automatic-Reboot stays false): security packages install on
# the daily timer; a kernel update needs a manual reboot to take effect.
systemctl enable --now unattended-upgrades 2>/dev/null || true
ok "unattended-upgrades enabled (APT::Periodic configured; no auto-reboot)"

# Kubernetes networking modules must exist before bridge sysctls are applied.
cat > /etc/modules-load.d/k8s.conf <<'EOF'
overlay
br_netfilter
EOF
modprobe overlay
modprobe br_netfilter
ok "Kernel modules loaded: overlay, br_netfilter"

# Sysctl
cat > /etc/sysctl.d/99-k8s-hardening.conf <<'EOF'
# Required for k8s networking
net.ipv4.ip_forward = 1
net.bridge.bridge-nf-call-iptables = 1

# Security hardening
net.ipv4.conf.all.rp_filter = 1
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv6.conf.all.accept_redirects = 0

# Memory: pairs with the swapfile below. Low swappiness = swap only under real
# pressure (a relief valve), never proactively — anon pages stay in RAM at rest.
vm.swappiness = 10
EOF

sysctl --system &>/dev/null
ok "Sysctl hardened"

# Swap — relief valve against memory-pressure I/O hangs.
# If the host already has swap (partition, LVM or file), preserve it as-is.
# Without swap, a memory spike can make the kernel evict file-backed
# pages — executable text, mmap'd files — and immediately re-faults them from
# disk (major page faults). At thousands/s this saturates the virtual disk's
# read path until tasks wedge in D state and the VM looks like an I/O hang.
# A small fallback swapfile absorbs the spike. Safe for kubelet: k0s sets
# failSwapOn=false with NoSwap behavior, so pods never swap — host-level only.
SWAPFILE=/swapfile
SWAP_SIZE=4G
active_swap=$(swapon --show=NAME --noheadings 2>/dev/null | awk 'NF { print $1; exit }')
if [ -n "$active_swap" ]; then
  SWAP_STATUS="existing swap preserved ($active_swap)"
  ok "Existing swap preserved ($active_swap)"
else
  if [ ! -f "$SWAPFILE" ]; then
    fallocate -l "$SWAP_SIZE" "$SWAPFILE" \
      || dd if=/dev/zero of="$SWAPFILE" bs=1M count=4096 status=none
    chmod 600 "$SWAPFILE"
    mkswap "$SWAPFILE" >/dev/null
  fi
  swapon "$SWAPFILE"
  SWAP_STATUS="fallback $SWAP_SIZE at $SWAPFILE"
  ok "Swap enabled ($SWAP_SIZE at $SWAPFILE, swappiness=10)"

# Persist only the fallback created by this script. Existing host swap remains
# under the host's own storage configuration.
  if ! grep -qE "^[[:space:]]*$SWAPFILE[[:space:]]" /etc/fstab; then
    echo "$SWAPFILE none swap sw 0 0" >> /etc/fstab
    ok "Swap persisted in /etc/fstab"
  fi
fi

# ─── Phase 2: Install tools ──────────────────────────────────────────
log "Phase 2 — Tools"

# k0s
if command -v k0s &>/dev/null && k0s version 2>/dev/null | grep -q "${K0S_VERSION#v}"; then
  ok "k0s ${K0S_VERSION} already installed"
else
  k0s_tmp=$(mktemp -d)
  curl -fsSLo "$k0s_tmp/$K0S_ASSET" "$K0S_RELEASE_URL/$K0S_ASSET"
  curl -fsSLo "$k0s_tmp/sha256sums.txt" "$K0S_RELEASE_URL/sha256sums.txt"
  verify_sha256 "$k0s_tmp" sha256sums.txt "$K0S_ASSET" \
    || fail "k0s checksum verification failed"
  install -o root -g root -m 0755 "$k0s_tmp/$K0S_ASSET" /usr/local/bin/k0s
  rm -rf "$k0s_tmp"
  ok "k0s ${K0S_VERSION} installed and checksum-verified"
fi

# helm
if command -v helm &>/dev/null && helm version --short 2>/dev/null | grep -q "^${HELM_VERSION}+"; then
  ok "helm ${HELM_VERSION} already installed"
else
  helm_tmp=$(mktemp -d)
  curl -fsSLo "$helm_tmp/$HELM_ASSET" "$HELM_RELEASE_URL/$HELM_ASSET"
  curl -fsSLo "$helm_tmp/$HELM_ASSET.sha256" "$HELM_RELEASE_URL/$HELM_ASSET.sha256"
  verify_sha256 "$helm_tmp" "$HELM_ASSET.sha256" "$HELM_ASSET" \
    || fail "Helm checksum verification failed"
  tar -xzf "$helm_tmp/$HELM_ASSET" -C "$helm_tmp"
  install -o root -g root -m 0755 "$helm_tmp/linux-${DEB_ARCH}/helm" /usr/local/bin/helm
  rm -rf "$helm_tmp"
  ok "helm ${HELM_VERSION} installed and checksum-verified"
fi

# flux
if command -v flux &>/dev/null && flux --version 2>/dev/null | grep -q "flux version ${FLUX_VERSION}$"; then
  ok "flux CLI ${FLUX_VERSION} already installed"
else
  flux_tmp=$(mktemp -d)
  curl -fsSLo "$flux_tmp/$FLUX_ASSET" "$FLUX_RELEASE_URL/$FLUX_ASSET"
  curl -fsSLo "$flux_tmp/checksums.txt" "$FLUX_RELEASE_URL/flux_${FLUX_VERSION}_checksums.txt"
  verify_sha256 "$flux_tmp" checksums.txt "$FLUX_ASSET" \
    || fail "Flux checksum verification failed"
  tar -xzf "$flux_tmp/$FLUX_ASSET" -C "$flux_tmp" flux
  install -o root -g root -m 0755 "$flux_tmp/flux" /usr/local/bin/flux
  rm -rf "$flux_tmp"
  ok "flux CLI ${FLUX_VERSION} installed and checksum-verified"
fi

# age
if command -v age &>/dev/null; then
  ok "age already installed"
else
  apt-get install -y -qq --no-install-recommends age
  ok "age installed"
fi

# sops
if command -v sops &>/dev/null && sops --version 2>/dev/null | grep -q "sops ${SOPS_VERSION}"; then
  ok "sops ${SOPS_VERSION} already installed"
else
  sops_tmp=$(mktemp -d)
  curl -fsSLo "$sops_tmp/$SOPS_ASSET" "$SOPS_RELEASE_URL/$SOPS_ASSET"
  curl -fsSLo "$sops_tmp/checksums.txt" "$SOPS_RELEASE_URL/sops-v${SOPS_VERSION}.checksums.txt"
  verify_sha256 "$sops_tmp" checksums.txt "$SOPS_ASSET" \
    || fail "SOPS checksum verification failed"
  install -o root -g root -m 0755 "$sops_tmp/$SOPS_ASSET" /usr/local/bin/sops
  rm -rf "$sops_tmp"
  ok "sops ${SOPS_VERSION} installed and checksum-verified"
fi

# Prove that the supplied identity is the repository's official SOPS key and
# can actually decrypt repository secrets before creating the cluster secret.
repo_age_recipient=$(awk '$1 == "age:" { print $2; exit }' "$REPO_DIR/.sops.yaml")
[ -n "$repo_age_recipient" ] || fail "No AGE recipient found in $REPO_DIR/.sops.yaml"
provided_age_recipient=$(age-keygen -y "$AGE_KEY_FILE" 2>/dev/null) \
  || fail "Could not derive recipient from AGE_KEY_FILE"
[ "$provided_age_recipient" = "$repo_age_recipient" ] \
  || fail "AGE_KEY_FILE does not match the repository SOPS recipient"
SOPS_AGE_KEY_FILE="$AGE_KEY_FILE" \
  sops --decrypt "$REPO_DIR/infrastructure/shared-secrets/secrets.yaml" >/dev/null \
  || fail "AGE_KEY_FILE cannot decrypt repository secrets"
ok "Official AGE key verified against repository secrets"

# runsc (gVisor) — untrusted-compute runtime substrate (ADR 0027).
if command -v runsc &>/dev/null && runsc --version 2>/dev/null | grep -q "$RUNSC_VERSION"; then
  ok "runsc ${RUNSC_VERSION} already installed"
else
  gvisor_tmp=$(mktemp -d)
  curl -fsSLo "$gvisor_tmp/runsc" "$GVISOR_RELEASE_URL/runsc"
  curl -fsSLo "$gvisor_tmp/runsc.sha512" "$GVISOR_RELEASE_URL/runsc.sha512"
  curl -fsSLo "$gvisor_tmp/containerd-shim-runsc-v1" "$GVISOR_RELEASE_URL/containerd-shim-runsc-v1"
  curl -fsSLo "$gvisor_tmp/containerd-shim-runsc-v1.sha512" "$GVISOR_RELEASE_URL/containerd-shim-runsc-v1.sha512"
  (cd "$gvisor_tmp" && sha512sum -c runsc.sha512 && sha512sum -c containerd-shim-runsc-v1.sha512)
  chmod a+rx "$gvisor_tmp/runsc" "$gvisor_tmp/containerd-shim-runsc-v1"
  mv "$gvisor_tmp/runsc" "$gvisor_tmp/containerd-shim-runsc-v1" /usr/local/bin/
  rm -rf "$gvisor_tmp"
  ok "runsc ${RUNSC_VERSION} installed"
fi

mkdir -p /etc/k0s/containerd.d
cat > /etc/k0s/containerd.d/gvisor.toml <<'EOF'
version = 2
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"
  runtime_path = "/usr/local/bin/containerd-shim-runsc-v1"
EOF
ok "containerd runsc drop-in written (k0s reloads containerd automatically)"

# ─── Phase 3: Secrets ────────────────────────────────────────────────
log "Phase 3 — Secrets"

# AES key for encryption at rest
if [ -f "$AES_KEY_FILE" ]; then
  chown root:root "$AES_KEY_FILE"
  chmod 600 "$AES_KEY_FILE"
  aes_key_bytes=$(base64 --decode "$AES_KEY_FILE" 2>/dev/null | wc -c)
  [ "$aes_key_bytes" -eq 32 ] \
    || fail "Existing AES key is not valid base64 encoding exactly 32 bytes"
  ok "Valid 32-byte AES key already exists at $AES_KEY_FILE"
else
  mkdir -p "$(dirname "$AES_KEY_FILE")"
  head -c 32 /dev/urandom | base64 > "$AES_KEY_FILE"
  chown root:root "$AES_KEY_FILE"
  chmod 600 "$AES_KEY_FILE"
  warn "Generated AES key — back it up: $AES_KEY_FILE"
fi

# ─── Phase 4: Configure and start k0s ────────────────────────────────
log "Phase 4 — k0s cluster"

mkdir -p /etc/k0s

# Template k0s.yaml
sed "s/__PUBLIC_IP__/$PUBLIC_IP/g" \
  "$BOOTSTRAP_DIR/k0s.yaml" > /etc/k0s/k0s.yaml
ok "k0s.yaml templated"

if k0s status &>/dev/null 2>&1; then
  ok "k0s already running"
else
  k0s install controller --single --config /etc/k0s/k0s.yaml

  # Place encryption config before first start
  mkdir -p /var/lib/k0s/pki
  sed "s|__AES_KEY__|$(cat "$AES_KEY_FILE")|g" \
    "$BOOTSTRAP_DIR/encryptionconfig.yaml" > /var/lib/k0s/pki/encryptionconfig.yaml
  chmod 600 /var/lib/k0s/pki/encryptionconfig.yaml
  ok "Encryption at rest configured"

  k0s start

  # kube-apiserver runs as its own user — fix ownership after k0s generates the user
  wait_for "API server user exists" id kube-apiserver
  chown kube-apiserver:root /var/lib/k0s/pki/encryptionconfig.yaml

  ok "k0s started"
fi

# Wait for API server
wait_for "API server ready" k0s kubectl get --raw /healthz

# Export kubeconfig
mkdir -p /root/.kube
k0s kubeconfig admin > /root/.kube/config
chmod 600 /root/.kube/config
export KUBECONFIG=/root/.kube/config
ok "Kubeconfig at /root/.kube/config"

# ─── Phase 4b: netguard (SSH dead-man's switch) ──────────────────────
log "Phase 4b — netguard connectivity watchdog"

# Bound to k0scontroller's lifecycle (BindsTo + WantedBy): starts/stops WITH
# k0s, so it can never be forgotten. If Cilium's datapath takes the host
# network down for >3 min, netguard masks+stops k0s and restores the host
# firewall (reboot only if that's not enough) — so SSH always comes back.
cat > /usr/local/bin/netguard <<'NGEOF'
#!/usr/bin/env bash
# netguard — connectivity watchdog for the single-NIC k0s/Cilium VPS.
#
# Runs ONLY while k0scontroller is active (systemd BindsTo + WantedBy), so it
# can never be "forgotten": you cannot bring Cilium up without the guard up.
#
# It probes external reachability. If the host loses ALL external connectivity
# for >GRACE seconds, it reverts the only thing that takes over the host
# datapath (k0s/Cilium) so SSH always comes back:
#     mask + stop k0scontroller  ->  restore host nftables  ->  reboot if still dead.
# mask survives a reboot, so the broken stack never auto-restarts into a loop.
set -u

GRACE=${NETGUARD_GRACE:-180}        # sustained total loss before acting (3 min)
INTERVAL=${NETGUARD_INTERVAL:-15}   # probe cadence (s)
TAG=netguard

iface() { ip route show default 2>/dev/null | awk '/default/{print $5; exit}'; }
gw()    { ip route show default 2>/dev/null | awk '/default/{print $3; exit}'; }

# Reachable if ANY of: default gateway, two public IPs, or a public TCP:443.
# In a Cilium datapath takeover ALL of these die together; in normal operation
# at least one answers — so this only fires on genuine total network death.
probe_ok() {
  local g; g=$(gw)
  [ -n "$g" ] && ping -c1 -W2 "$g" >/dev/null 2>&1 && return 0
  ping -c1 -W2 1.1.1.1 >/dev/null 2>&1 && return 0
  ping -c1 -W2 8.8.8.8 >/dev/null 2>&1 && return 0
  timeout 3 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>/dev/null && return 0
  return 1
}

revert() {
  local IF; IF=$(iface)
  logger -t "$TAG" "REVERT: sustained network loss — disable+stop k0scontroller, restore host firewall"
  systemctl disable k0scontroller >/dev/null 2>&1 || true    # EFFECTIVE anti-loop: mask can't mask a /etc unit; disable kills boot auto-start
  systemctl mask k0scontroller >/dev/null 2>&1 || true       # best-effort extra (blocks manual start where mask applies)
  timeout 45 systemctl stop k0scontroller >/dev/null 2>&1 || true
  # best-effort: detach Cilium eBPF/datapath leftovers from the NIC
  [ -n "$IF" ] && tc qdisc del dev "$IF" clsact >/dev/null 2>&1 || true
  for l in cilium_host cilium_net cilium_vxlan; do ip link del "$l" >/dev/null 2>&1 || true; done
  # restore the clean host firewall (in case docker/cilium mangled nft)
  nft -f /etc/nftables.conf >/dev/null 2>&1 || true
  sleep 25
  if probe_ok; then
    logger -t "$TAG" "RECOVERED without reboot. k0s is MASKED — fix the config, then: systemctl unmask k0scontroller"
    exit 0
  fi
  logger -t "$TAG" "still unreachable after stop — rebooting (k0s masked => clean boot)"
  systemctl reboot
}

case "${1:-watch}" in
  selftest)
    echo "iface=$(iface) gw=$(gw) grace=${GRACE}s interval=${INTERVAL}s"
    if probe_ok; then echo "probe: REACHABLE"; else echo "probe: DOWN"; fi
    ;;
  revert)
    revert
    ;;
  watch)
    logger -t "$TAG" "watchdog up (grace=${GRACE}s interval=${INTERVAL}s iface=$(iface) gw=$(gw))"
    last_ok=$(date +%s)
    while true; do
      if probe_ok; then
        last_ok=$(date +%s)
      else
        now=$(date +%s)
        if [ $(( now - last_ok )) -ge "$GRACE" ]; then
          # launch revert DETACHED, so BindsTo stopping us (when k0s stops) can't abort it
          systemd-run --unit=netguard-revert --collect /usr/local/bin/netguard revert >/dev/null 2>&1 \
            || /usr/local/bin/netguard revert
          exit 0
        fi
      fi
      sleep "$INTERVAL"
    done
    ;;
  *)
    echo "usage: netguard [watch|selftest|revert]" >&2
    exit 2
    ;;
esac
NGEOF
chmod +x /usr/local/bin/netguard

cat > /etc/systemd/system/netguard.service <<'NGSVC'
[Unit]
Description=netguard — connectivity watchdog (auto-reverts k0s/Cilium if the host loses network)
BindsTo=k0scontroller.service
After=k0scontroller.service network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/netguard watch
Restart=on-failure
RestartSec=10

[Install]
WantedBy=k0scontroller.service
NGSVC

systemctl daemon-reload
systemctl enable --now netguard.service 2>/dev/null
systemctl is-active --quiet netguard.service || fail "netguard failed to start"
ok "netguard active — auto-arms whenever k0s runs (3-min grace)"

# ─── Phase 5: CNI bootstrap (chicken-and-egg) ────────────────────────
log "Phase 5 — Cilium CNI (pre-Flux)"

# Flux needs pods → pods need CNI → CNI is a HelmRelease managed by Flux.
# Break the cycle: install Cilium via helm. When Flux starts, its
# helm-controller adopts the existing release (ADR 0006).

if helm status cilium -n kube-system &>/dev/null 2>&1; then
  ok "Cilium Helm release already exists"
else
  helm repo add cilium https://helm.cilium.io
  helm repo update cilium
  helm install cilium cilium/cilium \
    --namespace kube-system \
    --version 1.19.2 \
    --set kubeProxyReplacement=false \
    --set operator.replicas=1 \
    --set k8sServiceHost=localhost \
    --set k8sServicePort=6443 \
    --set ipam.operator.clusterPoolIPv4PodCIDRList='{10.244.0.0/16}' \
    --set hubble.enabled=true \
    --set operator.resources.requests.cpu=50m \
    --set operator.resources.requests.memory=64Mi \
    --set operator.resources.limits.memory=256Mi \
    --set resources.requests.cpu=100m \
    --set resources.requests.memory=128Mi \
    --set resources.limits.memory=512Mi \
    --wait --timeout 120s
  ok "Cilium installed via Helm"
fi

wait_for "Node Ready" k0s kubectl wait --for=condition=Ready node --all --timeout=120s

# ─── Phase 6: Flux bootstrap ─────────────────────────────────────────
log "Phase 6 — Flux"

# Install the checked-in Flux controllers and sync definition directly. Unlike
# `flux bootstrap git`, this path cannot create a commit or push to the repo.
# The migration commit is published deliberately before this script is run.
k0s kubectl create namespace flux-system --dry-run=client -o yaml \
  | k0s kubectl apply --server-side -f -

k0s kubectl apply --server-side \
  -f "$REPO_DIR/$CLUSTER_PATH/flux-system/gotk-components.yaml"
k0s kubectl -n flux-system rollout status deployment/source-controller --timeout=300s
k0s kubectl -n flux-system rollout status deployment/kustomize-controller --timeout=300s
k0s kubectl -n flux-system rollout status deployment/helm-controller --timeout=300s
k0s kubectl -n flux-system rollout status deployment/notification-controller --timeout=300s
ok "Checked-in Flux controllers are running"

# Converge both secrets on every run, so replacing either source file is
# reflected in-cluster instead of silently retaining stale credentials.
k0s kubectl -n flux-system create secret generic sops-age \
  --from-file=age.agekey="$AGE_KEY_FILE" --dry-run=client -o yaml \
  | k0s kubectl apply --server-side -f -

deploy_pub_tmp=$(mktemp)
ssh-keygen -y -f "$DEPLOY_KEY_FILE" > "$deploy_pub_tmp"
k0s kubectl -n flux-system create secret generic flux-system \
  --from-file=identity="$DEPLOY_KEY_FILE" \
  --from-file=identity.pub="$deploy_pub_tmp" \
  --from-file=known_hosts=/root/.ssh/known_hosts \
  --dry-run=client -o yaml \
  | k0s kubectl apply --server-side -f -
rm -f "$deploy_pub_tmp"
ok "Flux Git and SOPS credentials applied"

k0s kubectl apply --server-side \
  -f "$REPO_DIR/$CLUSTER_PATH/flux-system/gotk-sync.yaml"
flux_source_ready() {
  [ "$(k0s kubectl -n flux-system get gitrepository flux-system \
    -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = True ]
}
wait_for "Flux source reconciliation ready" flux_source_ready
ok "Flux installed from the local clone without writing to Git"

# ─── Phase 7: Host terminal ──────────────────────────────────────────
log "Phase 7 — terminal.bretagne.dev host services"

TTYD_VERSION="$TTYD_VERSION" OAUTH2_PROXY_VERSION="$OAUTH2_PROXY_VERSION" \
  "$BOOTSTRAP_DIR/terminal-host/provision.sh"
ok "Dedicated dev terminal provisioned"

# ─── Done ─────────────────────────────────────────────────────────────
log "Bootstrap complete"

printf '\n'
printf '    Cluster:   bretagne (k0s %s)\n' "$K0S_VERSION"
printf '    API:       https://%s:6443 (blocked from internet)\n' "$PUBLIC_IP"
printf '    Firewall:  22/443 accepted — Kubernetes/metrics ports internal\n'
printf '    SSH:       password disabled, root key-only\n'
printf '    fail2ban:  active\n'
printf '    Swap:      %s (swappiness=10)\n' "$SWAP_STATUS"
printf '    Updates:   unattended-upgrades active\n'
printf '    Flux:      watching main → %s\n' "$CLUSTER_PATH"
printf '    SOPS:      age key loaded in flux-system/sops-age\n'
printf '    Terminal:  dev + NOPASSWD sudo; ttyd host service provisioned\n'
printf '\n'
printf '    Watch reconciliation:\n'
printf '      flux get kustomizations --watch\n\n'
