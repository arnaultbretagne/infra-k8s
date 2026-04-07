# ADR 0017 — Preview-in-Prod for QA

## Status

Draft

## Context

CI tests (unit, integration) validate that code compiles and passes automated checks. They do not validate that a service behaves correctly in its real production context — with real dependencies, real networking, real data. A separate staging environment does not solve this either: it is a degraded copy of production that gives a false sense of confidence.

The data engineering world solved this problem years ago: tools like SQLMesh allow testing schema changes against production data by creating virtual layers that override only what changed, while reading from production for everything else. The same principle applies to services on Kubernetes.

The goal: when a PR is opened on infra-k8s (whether from Flux Image Automation, Renovate, or a human), spin up the changed service in production — isolated from user traffic — so it can be validated against real dependencies before merging.

**The PR becomes the unit of QA, not just the unit of approval.**

## Decision

Preview-in-prod: ephemeral environments within the production cluster, scoped to a PR, torn down on merge or close. Lifecycle managed by the Flux Operator's ResourceSet with GitHub Pull Request input provider.

## Rationale

### The Principle

Only what changes is deployed. Everything else is production. A preview environment for a Pocket-ID version bump does not need its own Traefik, MetalLB, or Flannel — it only needs a Pocket-ID pod running the new version, connected to production dependencies, reachable via a preview-specific route.

### Lifecycle: Flux Operator ResourceSet

The Flux Operator (by ControlPlane, maintained by the Flux core team) provides `ResourceSet` with a `GitHubPullRequest` input provider. This is the Flux-native equivalent of ArgoCD's ApplicationSet Pull Request Generator.

The cluster watches GitHub for PRs with a specific label. When a matching PR is found, the ResourceSet templates and applies preview resources. When the PR is closed or merged, the resources are pruned automatically.

```yaml
apiVersion: fluxcd.controlplane.io/v1
kind: ResourceSetInputProvider
metadata:
  name: preview-prs
  namespace: flux-system
spec:
  type: GitHubPullRequest
  url: https://github.com/arnaultbretagne/infra-k8s
  secretRef:
    name: github-auth
  filter:
    labels:
      - "preview"
  interval: 5m
```

The ResourceSet then templates resources per PR using `<< inputs.id >>`, `<< inputs.sha >>`, `<< inputs.branch >>` variables.

Key properties:
- **The cluster pulls** — it polls GitHub, no external actor pushes resources in. Consistent with the GitOps model (ADR 0002) and access boundaries (ADR 0016)
- **Automatic cleanup** — resources are pruned when the PR disappears from the filtered list (closed/merged)
- **Label-gated** — only PRs with the `preview` label trigger a preview. Not every Renovate bump needs one
- **Webhook-compatible** — Flux `Receiver` can trigger instant reconciliation instead of waiting for the poll interval
- **Skip labels** — `!ci-passed` pauses the preview until CI completes the image build

### Namespace Strategy

Following the pattern from the official Flux Operator documentation: a single shared `preview` namespace, not one namespace per PR. Resources are differentiated by name suffix (`-pr<< inputs.id >>`).

The ResourceSet creates per PR:
1. A `GitRepository` that checks out the PR commit
2. A `Kustomization` (Flux) that applies from that checkout with `nameSuffix: -pr<< inputs.id >>` and `targetNamespace: preview`
3. An `HTTPRoute` for preview traffic routing

### Traffic Routing

Gateway API makes this native. An HTTPRoute can match on headers or subdomains:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: pocket-id-pr<< inputs.id >>
  namespace: preview
spec:
  parentRefs:
    - name: bretagne-gateway
      namespace: traefik
  hostnames:
    - id.bretagne.dev
  rules:
    - matches:
        - headers:
            - name: x-preview
              value: "pr-<< inputs.id >>"
      backendRefs:
        - name: pocket-id-pr<< inputs.id >>
          port: 1411
```

Regular traffic (no header) goes to production. Traffic with the `x-preview` header goes to the preview. No impact on production users.

### Dependency Isolation

The default for all dependencies is: **point to production**. Isolation is only needed for dependencies where the preview writes.

| Dependency | Default (read) | Isolated (write) | Mechanism |
|---|---|---|---|
| **Database** | Prod read-only | Clone `pg_basebackup` | Label `db-clone` on PR |
| **S3/R2** | — | Path prefixed `preview-pr-<< inputs.id >>/` | Automatic in ResourceSet template |
| **Internal services** | Prod via cross-namespace DNS | — | No isolation needed (OIDC, etc. are read) |
| **External APIs** | Prod via OneCLI | Scoped/rate-limited token | Preview agent token in OneCLI (ADR 0013) |
| **Cache (Redis)** | — | Ephemeral instance | Always ephemeral by nature |

### Database Access: Label-Driven

The PR label determines the level of database isolation:

| Labels on PR | Database behavior |
|---|---|
| `preview` only | Preview connects to prod PG with a read-only user. Sufficient for version bumps, UI changes, read-path testing. |
| `preview` + `db-clone` | CNPG `pg_basebackup` clone of prod. Independent point-in-time copy, write-safe. Destroyed with the preview. Required for schema migrations. |

```yaml
# Clone example — ResourceSet conditionally creates this when db-clone label is present
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pocket-id-pg-pr<< inputs.id >>
  namespace: preview
spec:
  instances: 1
  bootstrap:
    pg_basebackup:
      source: pocket-id-pg  # clone from prod
```

For most PRs (version bumps with no schema change), read-only access to prod data is sufficient and costs nothing.

### Shared Secrets via Flux Operator copyFrom

Preview resources that need credentials (S3 for CNPG clones, OIDC client secrets) use the Flux Operator's `copyFrom` annotation to pull secrets from a source namespace without duplication:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cnpg-s3-creds
  namespace: preview
  annotations:
    fluxcd.controlplane.io/copyFrom: "flux-system/cnpg-s3-creds"
```

This is the same mechanism used in production (ADR 0012) — the Flux Operator handles cross-namespace secret distribution natively.

### What This Is NOT

- **Not a staging environment** — there is no permanent parallel cluster. Previews are ephemeral, per-PR, and test only what changed.
- **Not canary/blue-green deployment** — those are production rollout strategies that happen AFTER merge. Preview is pre-merge validation.
- **Not a replacement for CI tests** — CI validates code correctness (does it compile, do unit tests pass). Preview validates operational correctness (does it work in context).

## Open Questions

1. **Infrastructure changes** — a Traefik version bump or MetalLB config change cannot be tested in an isolated preview. These are inherently cluster-wide. For now, these are validated by reviewing the PR and relying on the Helm chart's own test suite. Preview-in-prod applies to application-level changes only.
2. **Cluster resource budget** — how many concurrent previews can a single-node VPS handle? A ResourceQuota on the `preview` namespace with strict memory limits could enforce a ceiling. Most PRs won't need previews (label-gated), so concurrent count should stay low.

## Consequences

- The Flux Operator must be deployed in the cluster (HelmRelease in infrastructure/controllers). It is also the mechanism for `copyFrom` secret distribution used in production.
- A shared `preview` namespace is pre-created as part of the infrastructure
- PRs on infra-k8s with the `preview` label trigger a preview; PRs without it do not
- The `db-clone` label triggers an ephemeral CNPG clone; without it, the preview uses prod PG read-only
- Gateway API header-based routing isolates preview traffic (already supported by Traefik, ADR 0008)
- CNPG must support read-only users and `pg_basebackup` cloning for preview databases
- Resource limits (ResourceQuota, LimitRange) on the `preview` namespace are critical on a single-node VPS
- The Flux Operator is AGPL-3.0 licensed — no issue for internal use, only relevant if distributing the software
