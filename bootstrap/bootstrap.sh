#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# infra-k8s bootstrap
# Bootstraps a k0s + Flux cluster on a fresh Debian VPS.
# Assumes: root access, internet, git clone of this repo at /srv/infra-k8s
# ============================================================================

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BOOTSTRAP_DIR="$REPO_DIR/bootstrap"

# -- Configuration -----------------------------------------------------------

K0S_VERSION="1.35.2+k0s.0"
FLUX_VERSION="2.8.3"
SOPS_VERSION="3.9.4"
FLANNEL_MANIFEST="$REPO_DIR/infrastructure/controllers/flannel/kube-flannel.yaml"

AGE_KEY_DIR="/root/.config/sops/age"
AGE_KEY_FILE="$AGE_KEY_DIR/keys.txt"
AES_KEY_FILE="/root/.config/k0s/encryption-key"

GITHUB_OWNER="arnaultbretagne"
GITHUB_REPO="infra-k8s"
CLUSTER_PATH="clusters/bretagne"

# -- Helpers -----------------------------------------------------------------

log() { echo "==> $*"; }
err() { echo "ERROR: $*" >&2; exit 1; }

check_root() {
  [[ $EUID -eq 0 ]] || err "Must run as root"
}

detect_public_ip() {
  PUBLIC_IP=$(ip -4 addr show scope global | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1)
  [[ -n "$PUBLIC_IP" ]] || err "Could not detect public IP"
  log "Public IP: $PUBLIC_IP"
}

# -- Phase 1: Install tools -------------------------------------------------

install_k0s() {
  if command -v k0s &>/dev/null; then
    log "k0s already installed: $(k0s version)"
    return
  fi
  log "Installing k0s ${K0S_VERSION}..."
  curl -sSLf https://get.k0s.sh | K0S_VERSION="v${K0S_VERSION}" sh
  log "k0s installed: $(k0s version)"
}

install_flux() {
  if command -v flux &>/dev/null; then
    log "flux already installed: $(flux --version)"
    return
  fi
  log "Installing flux ${FLUX_VERSION}..."
  curl -s https://fluxcd.io/install.sh | FLUX_VERSION="${FLUX_VERSION}" bash
  log "flux installed: $(flux --version)"
}

install_age() {
  if command -v age &>/dev/null; then
    log "age already installed"
    return
  fi
  log "Installing age..."
  apt-get update -qq && apt-get install -y -qq age
}

install_sops() {
  if command -v sops &>/dev/null; then
    log "sops already installed: $(sops --version)"
    return
  fi
  log "Installing sops ${SOPS_VERSION}..."
  local arch
  arch=$(dpkg --print-architecture)
  curl -sSLo /usr/local/bin/sops \
    "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.linux.${arch}"
  chmod +x /usr/local/bin/sops
}

# -- Phase 2: Generate secrets ----------------------------------------------

generate_age_key() {
  if [[ -f "$AGE_KEY_FILE" ]]; then
    log "Age key already exists at $AGE_KEY_FILE"
  else
    log "Generating Age key pair..."
    mkdir -p "$AGE_KEY_DIR"
    age-keygen -o "$AGE_KEY_FILE" 2>&1
    log "IMPORTANT: Back up $AGE_KEY_FILE to a secure location outside this VPS!"
  fi
  AGE_PUBLIC_KEY=$(grep "public key:" "$AGE_KEY_FILE" | cut -d: -f2 | tr -d ' ')
  log "Age public key: $AGE_PUBLIC_KEY"
}

generate_aes_key() {
  if [[ -f "$AES_KEY_FILE" ]]; then
    log "AES key already exists at $AES_KEY_FILE"
  else
    log "Generating AES-CBC encryption key..."
    mkdir -p "$(dirname "$AES_KEY_FILE")"
    head -c 32 /dev/urandom | base64 > "$AES_KEY_FILE"
    log "IMPORTANT: Back up $AES_KEY_FILE to a secure location outside this VPS!"
  fi
}

# -- Phase 3: Configure and start k0s ---------------------------------------

configure_k0s() {
  log "Writing k0s configuration..."
  mkdir -p /etc/k0s

  sed "s/__PUBLIC_IP__/$PUBLIC_IP/g" \
    "$BOOTSTRAP_DIR/k0s.yaml" > /etc/k0s/k0s.yaml
}

install_k0s_cluster() {
  if k0s status &>/dev/null 2>&1; then
    log "k0s already running"
    return
  fi

  log "Installing k0s controller (single-node)..."
  k0s install controller --single --config /etc/k0s/k0s.yaml

  # Write EncryptionConfiguration before starting (k0s install creates /var/lib/k0s/pki/)
  log "Writing EncryptionConfiguration..."
  local aes_key
  aes_key=$(cat "$AES_KEY_FILE")
  sed "s|__AES_KEY__|$aes_key|g" \
    "$BOOTSTRAP_DIR/encryptionconfig.yaml" > /var/lib/k0s/pki/encryptionconfig.yaml

  log "Starting k0s..."
  k0s start

  log "Waiting for API server (timeout: 120s)..."
  local waited=0
  until k0s kubectl get nodes &>/dev/null 2>&1; do
    sleep 2
    waited=$((waited + 2))
    [[ $waited -lt 120 ]] || err "API server not ready after 120s"
  done

  # Export kubeconfig
  mkdir -p /root/.kube
  k0s kubeconfig admin > /root/.kube/config
  export KUBECONFIG=/root/.kube/config

  log "k0s is running. Node status:"
  kubectl get nodes
}

# -- Phase 4: Apply Flannel (before Flux) ------------------------------------

apply_flannel() {
  if kubectl get ds -n kube-flannel kube-flannel-ds &>/dev/null 2>&1; then
    log "Flannel already deployed"
    return
  fi

  log "Applying Flannel CNI (server-side, field-manager=flux-system for Flux adoption)..."
  kubectl apply --server-side --field-manager=flux-system \
    -f "$FLANNEL_MANIFEST"

  log "Waiting for node to become Ready..."
  kubectl wait --for=condition=Ready node --all --timeout=120s
  log "Node is Ready"
}

# -- Phase 5: Bootstrap Flux ------------------------------------------------

setup_ufw() {
  if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
    log "Configuring UFW for Flannel VXLAN..."
    ufw allow 8472/udp comment "Flannel VXLAN" 2>/dev/null || true
    ufw allow 10250/tcp comment "kubelet" 2>/dev/null || true
  fi
}

bootstrap_flux() {
  if kubectl get ns flux-system &>/dev/null 2>&1; then
    log "flux-system namespace exists, checking Flux..."
    if flux check &>/dev/null 2>&1; then
      log "Flux already bootstrapped"
      return
    fi
  fi

  if [[ -z "${GITHUB_TOKEN:-}" ]]; then
    err "GITHUB_TOKEN is not set. Export it before running: export GITHUB_TOKEN=\$(gh auth token)"
  fi

  log "Bootstrapping Flux..."
  flux bootstrap github \
    --owner="$GITHUB_OWNER" \
    --repository="$GITHUB_REPO" \
    --branch=main \
    --path="$CLUSTER_PATH" \
    --personal \
    --token-auth

  log "Flux bootstrapped successfully"
}

create_sops_secret() {
  if kubectl get secret sops-age -n flux-system &>/dev/null 2>&1; then
    log "SOPS Age secret already exists in flux-system"
    return
  fi

  log "Creating SOPS Age secret in flux-system..."
  kubectl create secret generic sops-age \
    --namespace=flux-system \
    --from-file=age.agekey="$AGE_KEY_FILE"
  log "SOPS Age secret created"
}

# -- Main --------------------------------------------------------------------

main() {
  log "Starting infra-k8s bootstrap"
  check_root
  detect_public_ip

  # Phase 1: Tools
  install_k0s
  install_flux
  install_age
  install_sops

  # Phase 2: Secrets
  generate_age_key
  generate_aes_key

  # Phase 3: k0s
  configure_k0s
  setup_ufw
  install_k0s_cluster

  # Phase 4: CNI
  apply_flannel

  # Phase 5: Flux
  bootstrap_flux
  create_sops_secret

  log "Bootstrap complete!"
  log ""
  log "Flux will now reconcile the cluster. Watch progress with:"
  log "  export KUBECONFIG=/root/.kube/config"
  log "  flux get kustomizations --watch"
}

main "$@"
