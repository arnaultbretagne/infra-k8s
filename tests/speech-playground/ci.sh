#!/usr/bin/env bash
# The speech playground's e2e job (README.md), all of it: the workflow (workflow/speech-playground-e2e.yml) only
# checks out the repository, sets up Node and runs this script. Tools are pinned and checked against their sha256;
# the kind cluster gets the Gateway API and CiliumNetworkPolicy CRDs, so every object of the render is validated
# by the API server. No real secret: the Xiaomi key is made for the run.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="${RUNNER_TEMP:-$(mktemp -d)}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

KUBECTL_URL=https://dl.k8s.io/release/v1.36.5/bin/linux/amd64/kubectl
KUBECTL_SHA256=33bc88a24c3b09cf55bfd59e6ca977881b61fc3f25ab65bc80c65b430248648e
KIND_URL=https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-linux-amd64
KIND_SHA256=aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d
KIND_NODE_IMAGE=kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed
# infrastructure/sources/gateway-api.yaml's tag, and the CRD of infrastructure/controllers/cilium's chart version.
GATEWAY_API_URL=https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.3/standard-install.yaml
GATEWAY_API_SHA256=356c2b8e286a964dc20995435659ad1095386329974793af10bbfe3eff977fe5
CILIUM_CNP_CRD_URL=https://raw.githubusercontent.com/cilium/cilium/v1.20.2/pkg/k8s/apis/cilium.io/client/crds/v2/ciliumnetworkpolicies.yaml
CILIUM_CNP_CRD_SHA256=62c6de8f358da125b94468d39187edb1cea157d79503fdc50ccec8a6aaa79a76

echo "::group::kubectl and kind, checked against their sha256"
mkdir -p "$TMP/bin" "$TMP/dl"
curl -fsSL --retry 5 -o "$TMP/bin/kubectl" "$KUBECTL_URL"
curl -fsSL --retry 5 -o "$TMP/bin/kind" "$KIND_URL"
curl -fsSL --retry 5 -o "$TMP/dl/gateway-api.yaml" "$GATEWAY_API_URL"
curl -fsSL --retry 5 -o "$TMP/dl/cilium-cnp.yaml" "$CILIUM_CNP_CRD_URL"
echo "$KUBECTL_SHA256  $TMP/bin/kubectl" | sha256sum -c -
echo "$KIND_SHA256  $TMP/bin/kind" | sha256sum -c -
echo "$GATEWAY_API_SHA256  $TMP/dl/gateway-api.yaml" | sha256sum -c -
echo "$CILIUM_CNP_CRD_SHA256  $TMP/dl/cilium-cnp.yaml" | sha256sum -c -
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:$PATH"
echo "::endgroup::"

echo "::group::kind, with the Gateway API and CiliumNetworkPolicy CRDs"
kind create cluster --name speech-playground --image "$KIND_NODE_IMAGE" --wait 180s
kubectl apply --server-side -f "$TMP/dl/gateway-api.yaml"
kubectl apply --server-side -f "$TMP/dl/cilium-cnp.yaml"
kubectl wait --for=condition=Established crd/ciliumnetworkpolicies.cilium.io crd/httproutes.gateway.networking.k8s.io --timeout=60s
echo "::endgroup::"

echo "::group::Test dependencies and headless Chromium"
cd "$HERE"
npm ci --no-audit --no-fund
npx playwright install --with-deps chromium
echo "::endgroup::"

status=0
TARGET=kind npm test 2>&1 | tee "$TMP/kind.txt" || status=$?
{
  echo '### The speech playground in kind, against a fake OpenAI-compatible service and a fake Xiaomi MiMo'
  echo '```'
  grep -E '^ *(✔|✖|ℹ)' "$TMP/kind.txt" || true
  echo '```'
} >> "$SUMMARY"
if [ "$status" -ne 0 ]; then
  echo "::group::What the cluster holds"
  kubectl get pods -A -o wide || true
  kubectl -n speech-playground describe pods || true
  kubectl -n speech-playground logs deployment/speech-playground --all-containers || true
  kubectl -n speech-playground logs deployment/oauth2-proxy --all-containers || true
  kubectl get events -A --sort-by=.lastTimestamp | tail -50 || true
  echo "::endgroup::"
  exit "$status"
fi

# The leak test must bite: with scrub() made a no-op, the same tests must fail.
if MUTATE=no-scrub TARGET=local npm test > "$TMP/mutate.txt" 2>&1; then
  echo "::error::the tests passed with the server's scrub() disabled"
  cat "$TMP/mutate.txt"
  exit 1
fi
echo "MUTATE=no-scrub: failed, as it must:"
grep -E '^ *✖' "$TMP/mutate.txt" | sort -u
{
  echo '### With scrub() disabled (MUTATE=no-scrub), the key leaks and the tests fail, as they must'
  echo '```'
  grep -E '^ *✖' "$TMP/mutate.txt" | sort -u
  echo '```'
} >> "$SUMMARY"
