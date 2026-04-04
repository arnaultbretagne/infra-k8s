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
| State strategy | Stateless / S3-first | [0005](docs/adr/0005-stateless-s3-first.md) |
| CNI | Flannel (VXLAN overlay) | [0006](docs/adr/0006-flannel-cni.md) |
| Load balancer | MetalLB L2 | [0007](docs/adr/0007-metallb-loadbalancer.md) |
| Ingress controller | Traefik (ACME, middlewares, Gateway API) | [0008](docs/adr/0008-traefik-ingress-controller.md) |
| Identity | Pocket-ID (passkey-first OIDC) | [0009](docs/adr/0009-pocket-id-identity.md) |
| Auth middleware | Traefik OIDC plugin (in-process) | [0010](docs/adr/0010-traefik-oidc-plugin.md) |
| Encryption at rest | EncryptionConfiguration (AES-CBC) | [0011](docs/adr/0011-encryption-at-rest.md) |
| Database | CloudNativePG + Barman S3 backup | [0012](docs/adr/0012-cloudnativepg-database.md) |
| Credential injection | OneCLI (MITM proxy) | [0013](docs/adr/0013-onecli-credential-gateway.md) |
| Observability | Prometheus + Loki + Grafana + Alloy | [0014](docs/adr/0014-observability-stack.md) |
| CI/CD | Flux Image Automation + Renovate | [0015](docs/adr/0015-ci-cd-image-updates.md) |

## Repository structure

```
bootstrap/          Idempotent bootstrap script for a fresh Debian VPS
clusters/bretagne/  Flux Kustomization CRs (dependency chain entry point)
infrastructure/
  sources/          HelmRepository definitions
  controllers/      Flannel, Gateway API CRDs, MetalLB
  configs/          MetalLB IP pool, local-path-provisioner
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

Each layer is a Flux `Kustomization` with `dependsOn` on the previous one. The gateway and apps layers have SOPS decryption enabled.

## Bootstrap

Prerequisites: a Debian VPS with root SSH access, a GitHub PAT with `repo` scope.

```bash
git clone https://github.com/arnaultbretagne/infra-k8s.git /srv/infra-k8s
cd /srv/infra-k8s
export GITHUB_TOKEN=<your-token>
./bootstrap/bootstrap.sh
```

The script is idempotent and handles:
1. Installing k0s, Flux CLI, age, sops
2. Generating Age + AES keys (or loading existing ones)
3. Configuring k0s with EncryptionConfiguration for secrets at rest
4. Starting k0s, applying Flannel CNI
5. Bootstrapping Flux, creating the SOPS Age secret

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

Two bootstrap secrets live outside Git and must be backed up securely:
- **Age private key**: `/root/.config/sops/age/keys.txt`
- **AES encryption key**: `/root/.config/k0s/encryption-key`

## Verification

```bash
k0s status
kubectl get nodes                    # Ready
flux get kustomizations              # All layers Ready
kubectl get svc -n traefik           # EXTERNAL-IP assigned
curl -v https://id.bretagne.dev      # Pocket-ID responds with valid TLS
```
