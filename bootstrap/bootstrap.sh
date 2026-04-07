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

REPO_URL="ssh://git@github.com/ab-craft/infra-k8s.git"
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

# ─── Phase 5: CNI bootstrap (chicken-and-egg) ────────────────────────
log "Phase 5 — Flannel CNI (pre-Flux)"

# Flux needs pods → pods need CNI → CNI is a HelmRelease managed by Flux.
# Break the cycle: install Flannel via helm. When Flux starts, its
# helm-controller adopts the existing release.

if helm status flannel -n kube-flannel &>/dev/null 2>&1; then
  ok "Flannel Helm release already exists"
else
  kubectl create namespace kube-flannel --dry-run=client -o yaml \
    | kubectl apply --server-side -f -
  kubectl label namespace kube-flannel \
    pod-security.kubernetes.io/enforce=privileged --overwrite

  helm repo add flannel https://flannel-io.github.io/flannel
  helm repo update flannel
  helm install flannel flannel/flannel \
    --namespace kube-flannel \
    --version v0.28.2 \
    --set podCidr=10.244.0.0/16 \
    --set flannel.backend=vxlan \
    --set flannel.image.repository=ghcr.io/flannel-io/flannel \
    --set flannel.args='{--ip-masq,--kube-subnet-mgr}' \
    --set resources.requests.cpu=100m \
    --set resources.requests.memory=50Mi \
    --wait --timeout 120s
  ok "Flannel installed via Helm"
fi

wait_for "Node Ready" kubectl wait --for=condition=Ready node --all --timeout=120s

# ─── Phase 6: Flux bootstrap ─────────────────────────────────────────
log "Phase 6 — Flux"

# Create namespace + SOPS secret before bootstrap
kubectl create namespace flux-system --dry-run=client -o yaml \
  | kubectl apply --server-side -f -

if kubectl -n flux-system get secret sops-age &>/dev/null; then
  ok "sops-age secret already exists"
else
  kubectl -n flux-system create secret generic sops-age \
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
printf '    Flux:      watching main → %s\n' "$CLUSTER_PATH"
printf '    SOPS:      age key loaded in flux-system/sops-age\n'
printf '\n'
printf '    Watch reconciliation:\n'
printf '      flux get kustomizations --watch\n\n'
