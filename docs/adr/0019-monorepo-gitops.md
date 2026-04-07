# ADR 0019 — Monorepo for GitOps

## Status

Accepted

## Context

Flux supports two repository strategies for managing cluster state:

1. **Monorepo** — a single Git repository contains all infrastructure and application manifests
2. **Multi-repo** — infrastructure and each application live in separate repositories, connected via Flux `GitRepository` sources

The cluster is operated by a single person with a small number of applications.

## Decision

Monorepo. All infrastructure and application manifests live in `infra-k8s`.

## Rationale

**Monorepo** (chosen):
- Single source of truth — one `git log` shows the full history of what changed in the cluster and when
- Atomic changes — a PR can modify infrastructure and application manifests together (e.g., adding a new namespace + its app + its database in one commit)
- Simple dependency management — Flux Kustomizations reference paths within the same repo, no cross-repo version coordination
- Easier review — all cluster state is visible in one place
- Appropriate for the scale — one operator, <10 applications

**Multi-repo** (rejected):
- Better access control — each team owns their repo, infra team owns theirs. Not relevant with a single operator
- Independent release cycles — each app is deployed independently. Not needed when all deployments go through the same PR gate (ADR 0015)
- Avoids monorepo scaling issues (large repos, slow clones). Not a concern at this scale
- Adds coordination complexity — Flux needs multiple `GitRepository` sources, dependency ordering across repos is harder to reason about

### When to reconsider

Multi-repo becomes relevant if:
- Multiple operators with different access levels need to manage different parts of the cluster
- The number of applications grows beyond what a single repo makes readable (~20+)
- Application teams want independent deployment velocity without going through a shared PR queue

## Consequences

- All manifests (infrastructure + apps) are in `infra-k8s` under the Flux canonical structure (`clusters/`, `infrastructure/`, `apps/`)
- Flux uses a single `GitRepository` source (`flux-system`) for all Kustomizations
- Application source code remains in separate repos (ADR 0016) — only deployment manifests live here
- PRs on `infra-k8s` are the single gate for all cluster changes (ADR 0015)
