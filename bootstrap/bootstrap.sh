#!/usr/bin/env bash
# ============================================================================
# infra-k8s bootstrap
# Bootstraps a k0s + Flux cluster on a fresh Debian VPS.
# Idempotent — safe to re-run.
#
# Required inputs (env vars):
#   AGE_KEY_FILE    — path to the age private key for SOPS decryption
#   DEPLOY_KEY_FILE — path to the SSH deploy key for Flux git access
#
# Optional overrides:
#   PUBLIC_IP       — auto-detected if not set
#   AES_KEY_FILE    — auto-generated at /root/.config/k0s/encryption-key
# ============================================================================

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BOOTSTRAP_DIR="$REPO_DIR/bootstrap"

# ─── Configuration ────────────────────────────────────────────────────
K0S_VERSION="v1.35.2+k0s.0"
FLUX_VERSION="2.8.3"
SOPS_VERSION="3.9.4"

AES_KEY_FILE="${AES_KEY_FILE:-/root/.config/k0s/encryption-key}"

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

# ─── Preflight ────────────────────────────────────────────────────────
log "Preflight checks"

[ "$(id -u)" -eq 0 ] || fail "Must run as root"

for cmd in curl sed; do
  command -v "$cmd" &>/dev/null || fail "Missing required command: $cmd"
done

[ -n "${AGE_KEY_FILE:-}" ]    || fail "AGE_KEY_FILE not set"
[ -f "$AGE_KEY_FILE" ]        || fail "AGE_KEY_FILE not found: $AGE_KEY_FILE"
[ -n "${DEPLOY_KEY_FILE:-}" ] || fail "DEPLOY_KEY_FILE not set"
[ -f "$DEPLOY_KEY_FILE" ]     || fail "DEPLOY_KEY_FILE not found: $DEPLOY_KEY_FILE"

# Auto-detect public IP
if [ -z "${PUBLIC_IP:-}" ]; then
  PUBLIC_IP=$(ip -4 addr show scope global | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1)
  [ -n "$PUBLIC_IP" ] || fail "Could not detect public IP"
fi
ok "Public IP: $PUBLIC_IP"

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

    # HTTP / HTTPS (Traefik via MetalLB)
    tcp dport { 80, 443 } accept

    # K8s API — pod and service CIDRs only, blocked from internet
    ip saddr { 10.244.0.0/16, 10.96.0.0/12 } tcp dport 6443 accept

    # Kubelet — pods only
    ip saddr 10.244.0.0/16 tcp dport 10250 accept

    # ICMP
    ip protocol icmp accept
    ip6 nexthdr icmpv6 accept
  }
}
NFTEOF

nft -f /etc/nftables.conf
systemctl enable nftables 2>/dev/null
ok "Firewall: 22/80/443 public — 6443/10250 internal only"

# SSH hardening
SSH_HARDENING="/etc/ssh/sshd_config.d/99-bootstrap-hardening.conf"
if [ -f "$SSH_HARDENING" ]; then
  ok "SSH hardening already in place"
else
  cat > "$SSH_HARDENING" <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
ChallengeResponseAuthentication no
UsePAM yes
PubkeyAuthentication yes
EOF
  chmod 600 "$SSH_HARDENING"
  systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true
  ok "SSH hardened: password auth disabled, root key-only"
fi

# Fail2ban
if systemctl is-active --quiet fail2ban 2>/dev/null; then
  ok "fail2ban already running"
else
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends fail2ban
  systemctl enable --now fail2ban
  ok "fail2ban installed and enabled"
fi

# Automatic security updates
if systemctl is-active --quiet unattended-upgrades 2>/dev/null; then
  ok "unattended-upgrades already running"
else
  apt-get install -y -qq --no-install-recommends unattended-upgrades
  systemctl enable --now unattended-upgrades
  ok "unattended-upgrades installed and enabled"
fi

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
EOF

sysctl --system &>/dev/null
ok "Sysctl hardened"

# ─── Phase 2: Install tools ──────────────────────────────────────────
log "Phase 2 — Tools"

# k0s
if command -v k0s &>/dev/null && k0s version 2>/dev/null | grep -q "${K0S_VERSION#v}"; then
  ok "k0s ${K0S_VERSION} already installed"
else
  curl -sSLf https://get.k0s.sh | K0S_VERSION="$K0S_VERSION" sh
  ok "k0s installed"
fi

# helm
if command -v helm &>/dev/null; then
  ok "helm already installed"
else
  curl -sSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
  ok "helm installed"
fi

# flux
if command -v flux &>/dev/null; then
  ok "flux CLI already installed"
else
  curl -s https://fluxcd.io/install.sh | FLUX_VERSION="$FLUX_VERSION" bash
  ok "flux CLI installed"
fi

# age
if command -v age &>/dev/null; then
  ok "age already installed"
else
  apt-get update -qq && apt-get install -y -qq age
  ok "age installed"
fi

# sops
if command -v sops &>/dev/null; then
  ok "sops already installed"
else
  local_arch=$(dpkg --print-architecture)
  curl -sSLo /usr/local/bin/sops \
    "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.linux.${local_arch}"
  chmod +x /usr/local/bin/sops
  ok "sops installed"
fi

# ─── Phase 3: Secrets ────────────────────────────────────────────────
log "Phase 3 — Secrets"

# AES key for encryption at rest
if [ -f "$AES_KEY_FILE" ]; then
  ok "AES key already exists at $AES_KEY_FILE"
else
  mkdir -p "$(dirname "$AES_KEY_FILE")"
  head -c 32 /dev/urandom | base64 > "$AES_KEY_FILE"
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
systemctl enable netguard.service 2>/dev/null
ok "netguard installed — auto-arms whenever k0s runs (3-min grace)"

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
    --set hubble.relay.enabled=true \
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

# Create namespace + SOPS secret before bootstrap
k0s kubectl create namespace flux-system --dry-run=client -o yaml \
  | k0s kubectl apply --server-side -f -

if k0s kubectl -n flux-system get secret sops-age &>/dev/null; then
  ok "sops-age secret already exists"
else
  k0s kubectl -n flux-system create secret generic sops-age \
    --from-file=age.agekey="$AGE_KEY_FILE"
  ok "sops-age secret created"
fi

# Bootstrap Flux with deploy key (ADR 0016)
if flux check &>/dev/null 2>&1; then
  ok "Flux already running"
else
  flux bootstrap git \
    --url="$REPO_URL" \
    --branch=main \
    --path="$CLUSTER_PATH" \
    --private-key-file="$DEPLOY_KEY_FILE" \
    --silent
  ok "Flux bootstrapped"
fi

# ─── Done ─────────────────────────────────────────────────────────────
log "Bootstrap complete"

printf '\n'
printf '    Cluster:   bretagne (k0s %s)\n' "$K0S_VERSION"
printf '    API:       https://%s:6443 (blocked from internet)\n' "$PUBLIC_IP"
printf '    Firewall:  22/80/443 public — 6443/10250 internal\n'
printf '    SSH:       password disabled, root key-only\n'
printf '    fail2ban:  active\n'
printf '    Updates:   unattended-upgrades active\n'
printf '    Flux:      watching main → %s\n' "$CLUSTER_PATH"
printf '    SOPS:      age key loaded in flux-system/sops-age\n'
printf '\n'
printf '    Watch reconciliation:\n'
printf '      flux get kustomizations --watch\n\n'
