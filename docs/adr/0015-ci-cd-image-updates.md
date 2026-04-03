# ADR 0015 — CI/CD and Image Update Strategy

## Status

Accepted

## Context

The cluster is managed by Flux (ADR 0002) which deploys what is declared in the GitOps repo. But Flux does not build images — a strategy is needed for:

1. **Custom apps** (code-server, obsidian): who builds the image, who pushes the new tag to infra-k8s?
2. **Public images** (stremio, pocket-id, traefik, etc.): who detects new versions and proposes the update?
3. **Helm charts** (kube-prometheus-stack, loki, etc.): same

Two patterns coexist in the GitOps ecosystem: Flux Image Automation (monitors a registry and auto-commits new tags) and Renovate/Dependabot (opens PRs to bump versions).

## Decision

- **Custom apps**: GitHub Actions (CI) builds and pushes to GHCR, Flux Image Automation commits the new tag to infra-k8s
- **Public images + Helm charts**: Renovate (GitHub App) opens PRs on infra-k8s
- **Custom image builds remain necessary** for apps that modify the base image (system packages, binaries, patches)

## Rationale

### Two Types of Workloads

Current stacks fall into two categories:

**Apps without build** — wrap a public image with config. The application repo disappears, everything lives in infra-k8s:

| App | Public image | What goes in infra-k8s |
|---|---|---|
| stremio | `viren070/aiostreams` | Deployment + Service + HTTPRoute + SOPS Secret |
| pocket-id | `ghcr.io/pocket-id/pocket-id` | Deployment + Service + HTTPRoute + SOPS Secret |

**Apps with build** — contain custom code or system modifications that require a Dockerfile. The application repo remains for code + CI:

| App | Base image | Customizations | Why a build |
|---|---|---|---|
| code-server | `codercom/code-server` | System packages (tmux, gh, Claude CLI, Node.js), git/gh wrappers, VS Code patch, custom entrypoint | Too many system modifications (apt-get, binaries, image file patches) for init containers or ConfigMaps. The Dockerfile remains the cleanest |
| obsidian (sync) | Custom | TypeScript source code | Custom app, build required |
| obsidian (clipper) | Custom | Source code + Playwright/Chromium | Custom app, build required |

For code-server, the init container + ConfigMaps approach was evaluated. Wrappers and configs (gh-wrapper.sh, git-wrapper.sh, settings.json) could be ConfigMaps mounted as volumes. But system installations (apt-get, curl install) don't survive between an init container and the main container without a shared volume — it's fragile. The custom Dockerfile remains the best choice, pinning the base version (no `:latest`).

### CI: GitHub Actions

Custom image builds happen in GitHub Actions, in each app's repo:

```
ab-craft/code-server
  ├── Dockerfile
  ├── scripts/
  └── .github/workflows/build.yaml
        │
        │  trigger: push to main (or semver tag)
        ▼
  GitHub Actions:
    docker build
    docker push ghcr.io/ab-craft/code-server:v1.2.3
```

No alternative evaluated — GitHub Actions is already in place on the org, free for public repos, and natively integrated with GHCR.

### Custom Image Updates: Flux Image Automation

When CI pushes a new image to GHCR, the tag in infra-k8s must be updated. Flux Image Automation monitors the registry and auto-commits:

```yaml
# Flux monitors GHCR for new versions
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: code-server
spec:
  image: ghcr.io/ab-craft/code-server
  interval: 5m

# Policy: take the most recent semver tag
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: code-server
spec:
  imageRepositoryRef:
    name: code-server
  policy:
    semver:
      range: ">=1.0.0"

# Flux automatically commits the new tag to infra-k8s
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: infra-k8s
spec:
  git:
    commit:
      author:
        name: flux
        email: flux@bretagne.dev
    push:
      branch: main
  update:
    strategy: Setters
```

The full flow: push code → CI build → GHCR → Flux detects → commit tag to infra-k8s → Flux reconciles → rolling update. Fully automatic, no manual intervention.

### Public Image and Helm Chart Updates: Renovate

For third-party dependencies (public images, Helm charts), **Renovate** (free GitHub App hosted by Mend) monitors registries and opens PRs:

```
stremio v2.25.3 → v2.26.0 available on Docker Hub
  → Renovate opens a PR on infra-k8s
  → Review + merge
  → Flux deploys

kube-prometheus-stack 58.0 → 59.0 available
  → Renovate opens a PR
  → Review + merge
  → Flux deploys
```

**Why Renovate over Dependabot**:
- Dependabot is natively integrated in GitHub (zero installation) but does not understand **Helm values**, **Kustomize** files, or Docker tags in arbitrary YAML manifests
- Renovate understands all these formats natively: it detects versions in HelmReleases, Deployments, values.yaml, and even via custom regex
- Renovate is the norm in the GitOps/K8s ecosystem
- The free GitHub App runs on Mend infrastructure — no self-hosting needed. A `renovate.json` file at the repo root configures behavior

**Why not Flux Image Automation for public images**:
- Flux Image Automation auto-commits without review — acceptable for your own images (you control CI), risky for third-party images (a buggy version deploys automatically)
- Renovate opens a PR → you review before merging. This is the right level of control for external dependencies

### Workflow Summary

```
Custom images (full auto):
  Push code → GitHub Actions → GHCR → Flux Image Automation → deploy

Public images (PR review):
  New version → Renovate opens PR → review + merge → Flux deploy

Helm charts (PR review):
  New version → Renovate opens PR → review + merge → Flux deploy
```

## Consequences

- Application repos with builds (code-server, obsidian) keep their GitHub Actions CI and Dockerfile. Images are pushed to GHCR with semver tags
- Application repos without builds (stremio) disappear — their deployment is a manifest in infra-k8s
- Flux Image Automation (ImageRepository + ImagePolicy + ImageUpdateAutomation) is deployed in the cluster to monitor GHCR
- Renovate (GitHub App) is installed on the org with a `renovate.json` in infra-k8s
- Dockerfile base images must be version-pinned (no `:latest`) — Renovate will propose bumps via PR
- The deploy flow remains coherent with the current workflow (PR → merge → automatic deploy via Flux)
