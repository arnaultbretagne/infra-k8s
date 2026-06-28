# infra-k8s

GitOps repository for the `bretagne.dev` Kubernetes cluster. Single-node k0s managed by Flux CD.

## Architecture

Decisions are documented as ADRs in [`docs/adr/`](docs/adr/). Key choices:

| Component | Choice | ADR |
|---|---|---|
| Distribution | k0s (minimal, empty cluster) | [0001](docs/adr/0001-k0s-distribution.md) |
| GitOps | Flux CD | [0002](docs/adr/0002-flux-gitops.md) |
| Secrets | SOPS + Age (selective encryption in Git) | [0003](docs/adr/0003-sops-age-secrets.md) |
| Ingress standard | Gateway API (HTTPRoute) | [0004](docs/adr/0004-gateway-api-ingress.md) |
| State strategy | Stateless / S3-first (named stateful exceptions) | [0005](docs/adr/0005-stateless-s3-first.md) |
| CNI | Cilium (eBPF, kube-proxy replacement, NetworkPolicies) | [0006](docs/adr/0006-cilium-cni.md) |
| Load balancer | Cilium LB-IPAM + L2 announcement | [0006](docs/adr/0006-cilium-cni.md) ¹ |
| Ingress controller | Traefik (ACME, middlewares, Gateway API) | [0008](docs/adr/0008-traefik-ingress-controller.md) |
| Identity | Pocket-ID (passkey-first OIDC) | [0009](docs/adr/0009-pocket-id-identity.md) |
| Auth middleware | Traefik OIDC plugin (in-process) | [0010](docs/adr/0010-traefik-oidc-plugin.md) |
| Encryption at rest | EncryptionConfiguration (AES-CBC) | [0011](docs/adr/0011-encryption-at-rest.md) |
| Database | CloudNativePG + Barman S3 backup | [0012](docs/adr/0012-cloudnativepg-database.md) |
| Credential injection | OneCLI (MITM proxy) — *deferred* | [0013](docs/adr/0013-onecli-credential-gateway.md) |
| Observability | Prometheus + Loki + Grafana + Alloy | [0014](docs/adr/0014-observability-stack.md) |
| CI/CD | Flux Image Automation + Renovate | [0015](docs/adr/0015-ci-cd-image-updates.md) |
| Access boundaries | Deploy key; AI agent excluded from infra-k8s | [0016](docs/adr/0016-access-boundaries.md) |
| Preview / QA | Preview-in-prod (ephemeral, in-cluster) | [0017](docs/adr/0017-preview-in-prod.md) |
| Storage class | local-path-provisioner | [0018](docs/adr/0018-local-path-provisioner.md) |
| Repo strategy | Monorepo | [0019](docs/adr/0019-monorepo-gitops.md) |

¹ Supersedes MetalLB ([0007](docs/adr/0007-metallb-loadbalancer.md)) — Cilium handles LoadBalancer IP assignment natively.

> **Status note:** ADRs are *decisions*, not all implemented yet. Built today: k0s / Flux / Cilium / Traefik / Gateway API / CNPG / local-path + Pocket-ID. Decided but not yet built: observability (0014), CI/CD automation (0015), auth-enforcement wiring (0010), preview-in-prod (0017). Deferred: OneCLI (0013). MetalLB manifests are still present pending removal (ADR 0007 superseded).

## Repository structure

```
bootstrap/          Idempotent bootstrap script for a fresh Debian VPS
clusters/bretagne/  Flux Kustomization CRs (dependency chain entry point)
infrastructure/
  sources/          HelmRepository / OCI source definitions
  shared-secrets/   SOPS secrets distributed via Flux Operator copyFrom
  controllers/      Cilium (CNI + LB), CloudNativePG, Flux Operator
  configs/          local-path-provisioner (+ legacy MetalLB pool, pending removal)
  gateway/          Traefik HelmRelease, Gateway resource, middlewares
apps/               Application manifests (Pocket-ID, ...)
docs/adr/           Architecture Decision Records
```

## Flux dependency chain

```
flux-system
  └─ infrastructure-sources
       └─ infrastructure-controllers
            └─ infrastructure-configs
                 └─ infrastructure-gateway
                      └─ apps
```

Each layer is a Flux `Kustomization` with `dependsOn` on the previous one. The gateway and apps layers have SOPS decryption enabled. Apps include CNPG Cluster CRs alongside the application manifests, with S3 backup credentials distributed via the Flux Operator's `copyFrom`.

## Bootstrap

Prerequisites:
- a fresh Debian VPS with root SSH access
- the **Age private key** (SOPS decryption), restored from backup
- an **SSH deploy key** whose public half is registered as a deploy key (read/write) on this repo, for Flux git access

```bash
git clone https://github.com/arnaultbretagne/infra-k8s.git /srv/infra-k8s
cd /srv/infra-k8s

export AGE_KEY_FILE=/root/.config/sops/age/keys.txt    # restored from backup
export DEPLOY_KEY_FILE=/root/.ssh/infra-k8s-deploy      # private key; pubkey registered on the repo
# PUBLIC_IP is auto-detected; AES_KEY_FILE is auto-generated at
# /root/.config/k0s/encryption-key if absent

./bootstrap/bootstrap.sh    # run as root; idempotent, safe to re-run
```

The script handles:
1. OS hardening (nftables firewall, SSH, fail2ban, unattended-upgrades, sysctl)
2. Installing k0s, Helm, Flux CLI, age, sops (pinned versions)
3. Generating or loading the AES key for encryption at rest
4. Starting k0s (kube-proxy disabled), then installing Cilium via Helm (CNI + LB, pre-Flux)
5. Bootstrapping Flux with the deploy key and creating the SOPS Age secret

After bootstrap, Flux reconciles the full dependency chain automatically.

## Secrets

Secrets are encrypted with SOPS + Age. Only `data`/`stringData` fields are encrypted; metadata stays readable for meaningful diffs.

```bash
# Decrypt a secret for editing
sops --decrypt apps/pocket-id/secrets.yaml

# Edit in-place (opens $EDITOR, re-encrypts on save)
sops apps/pocket-id/secrets.yaml

# Encrypt a new secret file
sops --encrypt --in-place apps/my-app/secrets.yaml
```

Two bootstrap secrets must be backed up securely (losing them is unrecoverable):
- **Age private key**: `/root/.config/sops/age/keys.txt`
- **AES encryption key**: `/root/.config/k0s/encryption-key`

(The Flux deploy key is also needed at bootstrap but is replaceable — regenerate and re-register it if lost.)

## Verification

```bash
k0s status
k0s kubectl get nodes                 # Ready
flux get kustomizations               # All layers Ready
k0s kubectl get svc -n traefik        # EXTERNAL-IP assigned (by Cilium LB)
curl -v https://id.bretagne.dev       # Pocket-ID responds with valid TLS
```
