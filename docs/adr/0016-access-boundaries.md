# ADR 0016 — Access Boundaries and Repository Separation

## Status

Accepted

## Context

The infrastructure spans multiple Git repositories with different purposes and different actors interacting with them. Without clear boundaries, an agent that can push code could also (accidentally or via prompt injection) alter deployment manifests, bypassing the CI/CD pipeline.

The actors are:
- **Flux** — the GitOps controller, reconciles the cluster from `infra-k8s`
- **The AI agent** (running in code-server) — writes application code, pushes to app repos
- **GitHub Actions CI** — builds container images, pushes to GHCR
- **Flux Image Automation** — detects new images on GHCR, commits tag updates to `infra-k8s`
- **Renovate** — opens PRs on `infra-k8s` for dependency version bumps
- **The human operator** — reviews and merges PRs on `infra-k8s`, runs bootstrap

## Decision

Strict separation between the GitOps repo (`infra-k8s`) and application code repos. Each actor gets the minimum access it needs, via the appropriate authentication mechanism.

## Rationale

### Repository Separation

| Repo | Purpose | Contains |
|---|---|---|
| `infra-k8s` | GitOps — what runs on the cluster | K8s manifests, Helm values, SOPS secrets, bootstrap scripts, ADRs |
| App repos (e.g., obsidian-mcp, code-server) | Application code | Source code, Dockerfile, CI workflows, tests |

Application code has nothing to do with infrastructure. Mixing them would mean a code change and a deployment manifest change go through the same review process, with the same permissions. Separating them allows different access policies per repo.

Some applications may be further split: reusable components packaged as Helm charts (e.g., obsidian-sync) vs application-specific code (e.g., the MCP server). This is a per-app decision, not an infrastructure one.

### Access Model

| Actor | Repo access | Mechanism | Write to infra-k8s? |
|---|---|---|---|
| **Flux** | `infra-k8s` only | SSH deploy key (created at bootstrap, scoped to one repo) | Yes — read manifests, write to branches (never main) via Image Automation |
| **AI agent** | App repos only | GitHub App (scoped to app repos) | **No** |
| **GitHub Actions CI** | The app repo it runs in + GHCR | Automatic `GITHUB_TOKEN` + GHCR push | **No** |
| **Flux Image Automation** | GHCR (read) + `infra-k8s` (branch write) | Flux's deploy key | Branch only — commits tag updates to `flux-image-updates`, PR opened for merge |
| **Renovate** | Public registries + `infra-k8s` (PRs only) | Renovate GitHub App | PRs only — human merges |
| **Human operator** | Everything | Personal GitHub account | Yes — merges PRs, runs bootstrap |

### Why the Agent Must Not Access infra-k8s

The agent executes LLM-generated code. Even with guardrails, the risk of unintended modifications to deployment manifests is structurally higher than with traditional development. By scoping the agent's GitHub App to app repos only, a compromised or misdirected agent cannot:
- Alter SOPS-encrypted secrets in `infra-k8s`
- Change resource limits, network policies, or ingress routes
- Bypass the CI/CD pipeline to deploy directly

The agent's influence on the cluster is always indirect: push code → CI builds image → Flux deploys. Every step has a gate.

### Why Deploy Key for Flux (Not PAT, Not GitHub App)

- **PAT**: Tied to a person, broad `repo` scope across all repositories. If stored in the cluster, a compromised pod could access all repos. Rejected.
- **GitHub App**: Fine-grained, scoped permissions. Ideal for organizations with multiple repos/clusters. Overkill for a single personal repo — adds operational complexity (app creation, installation, private key management) without benefit.
- **Deploy key (SSH)**: Created automatically by `flux bootstrap`, scoped to exactly one repository, read/write. No token stored in the cluster (the SSH key is the credential). Simple, secure, default Flux behavior.

The `GITHUB_TOKEN` (PAT) is used once at bootstrap time to create the deploy key. It is never persisted in the cluster.

### Deployment Flow

```
Agent pushes code to app repo
  → GitHub Actions CI builds + pushes image to GHCR
    → Flux Image Automation detects new tag, pushes to branch
      → PR opened on infra-k8s
        → Human reviews + merges
          → Flux reconciles, rolling update

Renovate detects dependency update
  → Opens PR on infra-k8s
    → Human reviews + merges
      → Flux reconciles
```

Both paths converge on a PR. No actor can short-circuit this pipeline. The agent cannot push to `infra-k8s`. CI cannot deploy. Flux Image Automation cannot push to main. Renovate cannot merge. Only Flux deploys, and only from what is merged on main in `infra-k8s`.

### The Registry as Boundary

GHCR decouples app repos from infra-k8s completely. App repos push images to GHCR. Flux Image Automation polls GHCR from within the cluster. No app repo, no CI workflow, and no agent ever needs access to infra-k8s. The registry is the communication channel (ADR 0015).

## Consequences

- The AI agent's GitHub App must explicitly exclude `infra-k8s` from its installation scope
- Flux bootstrap creates a deploy key (read/write) automatically — write is needed for Image Automation branch pushes, but Flux never writes to main
- Flux Image Automation (ADR 0015) reuses Flux's deploy key for pushing to the `flux-image-updates` branch
- If moving to an organization with multiple infra repos, the deploy key approach should be re-evaluated in favor of a GitHub App for Flux
- The human operator is the only actor that can directly modify `infra-k8s` (via PRs or direct push on `main`)

## Amendment 2026-07-02 — three agents, and the PR-gate is a convention

- There are now **three distinct agents**, not one: (1) the **infra operator agent** (root on the box,
  `sudo k0s kubectl`, pushes to `infra-k8s` via the deploy key) — never modelled here; (2) the **claude
  runtime** in the `agent` pod (untrusted-by-design, bounded per AR/0003 — CNP + no SA token); (3) the
  **product/code agent** this ADR scopes out of `infra-k8s`. Each needs its own trust boundary; the
  single-actor model is stale.
- **"Flux never writes to `main`" is a convention, not a constraint.** The deploy key is read/**write**
  and commits go **directly to `main`** via it. GitHub **branch protection** is what makes the PR-gate
  real (S7). Until then, a cluster compromise that reaches the key can push to prod.
