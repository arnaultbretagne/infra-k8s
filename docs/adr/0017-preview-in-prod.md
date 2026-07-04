# ADR 0017 — Preview-in-Prod for QA

## Status

Accepted (April 2026). Hardened design for single-node (v2). **Amended 2026-07-04 (v3)** — pre-implementation review: applier authority, dedicated preview hosts, IdP exclusion, data mechanisms, quotas, honest tier-2 scope. Where the amendment contradicts the body, the amendment wins.

## Context

CI tests (unit, integration) validate that code compiles and passes automated checks. They do not validate that a service behaves correctly in its real production context — with real dependencies, real networking, real data. A separate staging environment does not solve this either: it is a degraded copy of production that gives a false sense of confidence.

The data engineering world solved this years ago: tools like SQLMesh test schema changes against production data by creating virtual layers that override only what changed, reading from production for everything else. The same principle applies to services on Kubernetes.

**The hard constraint:** there is exactly one always-on machine — the VPS. No second node, no paid preview cluster, no always-on local/home machine. So any preview environment must run where the always-on compute already is: **inside the production cluster.** This is not a showcase choice, it is the only option that fits the constraints. The design problem is therefore not "should we" but "how do we make a preview safe next to production — and next to the IdP — on a single shared node."

**The PR becomes the unit of QA, not just the unit of approval.**

## Decision

A **two-tier** preview strategy, so the heavy in-cluster path stays rare:

1. **Default tier — ephemeral CI preview.** Most PRs (a version bump, a UI tweak) only need "does it build, boot, and pass smoke tests." That runs as an ephemeral GitHub Actions job: build the image, boot the changed service, run smoke tests, tear down. Zero cluster footprint, free CI minutes, no always-on node. No live URL, no prod dependencies.

2. **On-demand tier — in-cluster preview-in-prod.** PRs labelled `preview` (the ones that must validate against *real* production dependencies) get an ephemeral environment inside the production cluster, scoped to the PR, torn down on merge/close. Lifecycle managed by the Flux Operator's ResourceSet with the GitHub Pull Request input provider.

The rest of this ADR specifies the on-demand tier and, critically, the isolation that makes it safe on a single node.

## Single-Node Isolation (the load-bearing part)

A preview runs your own in-flight PR code — not hostile code, but unreviewed, possibly-buggy code — in the same cluster as the IdP (Pocket-ID) and its database. Three controls bound the blast radius. These are not optional add-ons; they are the reason this ADR is acceptable.

### 1. Network — default-deny (Cilium NetworkPolicies)

The `preview` namespace gets a **default-deny** policy on both ingress and egress. Nothing is allowed until explicitly opened. Each preview then gets only the egress it needs:

- DNS (kube-dns) — always
- the Gateway (Traefik) for inbound preview traffic
- the *specific* production dependency it is allowed to read (e.g. Pocket-ID's read-only PG), and nothing else

This is exactly why the cluster runs Cilium (ADR 0006): Flannel accepts NetworkPolicies and silently ignores them — with Flannel this whole ADR would be unsafe. With Cilium they are enforced (and `CiliumNetworkPolicy` can restrict egress to L7 / DNS-FQDN if needed).

### 2. Resources — ResourceQuota + LimitRange

The `preview` namespace carries a hard `ResourceQuota` (total CPU/memory ceiling) and a `LimitRange` (per-pod default + max). A preview physically cannot starve production. Combined with label-gating (most PRs spawn nothing), concurrent preview count stays low by construction.

### 3. Data — read-only by default, clone on demand

The subtle risk: a preview must never write to prod data, and even *reading* prod data exposes it to PR code.

| Labels on PR | Database behaviour |
|---|---|
| `preview` only | Connects to prod PG with a **read-only** user. Fine for version bumps, UI, read-path testing — but the preview code still *sees* prod data, so this is a per-app decision. |
| `preview` + `db-clone` | CNPG `pg_basebackup` clone of prod — independent, write-safe, destroyed with the preview. Required for schema migrations, and the safe default for any app whose data is sensitive. |

S3/R2 writes from a preview always go to a `preview-pr-<< inputs.id >>/` prefix, never prod paths.

### Honest caveat — shared kernel

On a single node, namespaces + NetworkPolicies + quotas isolate **network and resources, not the kernel.** A container-escape vulnerability in preview code reaches the host. For *your own* in-flight PR code this is an accepted homelab-grade risk. The day previews need to run genuinely untrusted code, the answer is a sandboxed runtime (gVisor/Kata) or a throwaway node — not this design. Stated plainly so it is a known limit, not a surprise.

## Rationale

### The Principle

Only what changes is deployed. Everything else is production. A preview for a Pocket-ID version bump does not need its own Traefik or Cilium — only a Pocket-ID pod running the new version, connected (within the isolation above) to production dependencies, reachable via a preview-specific route.

### Lifecycle: Flux Operator ResourceSet

The Flux Operator (by ControlPlane, maintained by the Flux core team — AGPL-3.0, fine for internal use) provides `ResourceSet` with a `GitHubPullRequest` input provider. The Flux-native equivalent of ArgoCD's ApplicationSet PR Generator.

The cluster watches GitHub for labelled PRs, templates and applies preview resources, and prunes them when the PR is closed/merged.

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

Key properties:
- **The cluster pulls** — it polls GitHub, no external actor pushes resources in. Consistent with the GitOps model (ADR 0002) and access boundaries (ADR 0016)
- **Automatic cleanup** — resources pruned when the PR leaves the filtered list (closed/merged)
- **Label-gated** — only `preview` PRs trigger the in-cluster tier; everything else stays in the CI tier
- **Webhook-compatible** — a Flux `Receiver` can trigger instant reconciliation instead of waiting for the poll
- **Skip until CI** — `!ci-passed` pauses the preview until CI has built the image

### Namespace Strategy

A single shared `preview` namespace (per the official Flux Operator docs), not one namespace per PR. Resources are differentiated by name suffix (`-pr<< inputs.id >>`). The default-deny NetworkPolicy and the ResourceQuota live on this namespace.

The ResourceSet creates per PR:
1. A `GitRepository` that checks out the PR commit
2. A `Kustomization` applying from that checkout with `nameSuffix: -pr<< inputs.id >>` and `targetNamespace: preview`
3. An `HTTPRoute` for preview traffic routing

### Traffic Routing

Gateway API makes this native — an HTTPRoute matches on a header (or subdomain):

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

Regular traffic (no header) goes to production; `x-preview` traffic goes to the preview. No impact on production users.

### Dependency Isolation (summary)

Default for every dependency: **point to production, read-only.** Isolate only where the preview writes.

| Dependency | Default (read) | Isolated (write) | Mechanism |
|---|---|---|---|
| **Database** | Prod read-only user | `pg_basebackup` clone | Label `db-clone` |
| **S3/R2** | — | Path prefixed `preview-pr-<id>/` | Automatic in template |
| **Internal services** | Prod via cross-namespace DNS (allowed by NetworkPolicy) | — | Read-only by nature (OIDC, etc.) |
| **External APIs** | Prod creds (read) | Per-preview scoped/rate-limited token | OneCLI *if/when adopted* (ADR 0013, deferred) |
| **Cache (Redis)** | — | Ephemeral instance | Ephemeral by nature |

### Shared Secrets via Flux Operator copyFrom

Preview resources needing credentials (S3 for clones, OIDC client secrets) use the Flux Operator's `copyFrom` annotation — the same mechanism as production (ADR 0012):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cnpg-s3-creds
  namespace: preview
  annotations:
    fluxcd.controlplane.io/copyFrom: "flux-system/cnpg-s3-creds"
```

### What This Is NOT

- **Not a staging environment** — no permanent parallel cluster; previews are ephemeral, per-PR, test only what changed
- **Not canary/blue-green** — those are post-merge rollout strategies; preview is pre-merge validation
- **Not a replacement for CI** — CI validates code correctness; preview validates operational correctness

## Open Questions

1. **Infrastructure changes** — a Traefik or Cilium bump cannot be tested in an isolated preview; these are cluster-wide. They are validated by PR review + the Helm chart's own tests. Preview-in-prod is for application-level changes.
2. **CI-tier depth** — how far the default CI tier should go (smoke only vs. ephemeral compose with stub deps) is per-app and will firm up as apps migrate.

## Consequences

- The Flux Operator must be deployed (HelmRelease in infrastructure/controllers) — also the `copyFrom` mechanism used in production
- A shared `preview` namespace is pre-created with a **default-deny NetworkPolicy + ResourceQuota + LimitRange** as part of the infrastructure (not per-PR — these are the standing guardrails)
- The default preview path is an **ephemeral CI job**; the in-cluster path is opt-in via the `preview` label
- The `db-clone` label triggers an ephemeral CNPG clone; otherwise the preview uses prod PG read-only (a per-app decision, since read still exposes prod data)
- Gateway API header routing isolates preview traffic (Traefik, ADR 0008); Cilium NetworkPolicies isolate preview networking (ADR 0006) — the latter is what makes this safe
- Single-node = shared kernel: previews are isolated at the network/resource level, not hardware. Untrusted code would need gVisor/Kata or a separate node

## Amendment 2026-07-04 — v3: applier authority, dedicated hosts, data, quotas, honest scope

Pre-implementation review (nothing of the in-cluster tier was built yet — only the Flux Operator is
deployed). The body above stands except where superseded below. Companion: ADR 0027 (sandboxed runtime).

### 1. Applier authority — the load-bearing fix (supersedes the "cluster pulls" safety claim)

The body's security argument ("the cluster pulls, no external actor pushes") missed *with what
authority* the pulled content is applied. As specified, the templated `Kustomization` would be
reconciled by kustomize-controller, which runs **cluster-admin** (ADR 0020). That means **pre-merge PR
content applied with platform authority** — in direct contradiction with ADR 0026, which makes
`infra-k8s/main` the only path to cluster authority. Two aggravating facts:

- `targetNamespace`/`nameSuffix` only relocate/rename *namespaced* objects; a cluster-scoped object in
  the PR (ClusterRoleBinding, CiliumClusterwideNetworkPolicy, CRD…) would be applied as-is.
- **The label is checked once; the content is not.** After a maintainer labels the PR, every subsequent
  push to the branch is applied automatically. On a public repo, fork PRs make this chain reachable
  from outside: fork → PR → one-time label → later push = arbitrary manifests applied. The label IS an
  access-control decision, and it authorizes *future* commits.

**Decision (v3):**

- The templated `Kustomization` MUST set `spec.serviceAccountName: preview-applier` — a ServiceAccount
  in the `preview` namespace whose Role grants CRUD **only inside `preview`** and only on an allowlist
  of kinds (Deployments, Services, ConfigMaps, HTTPRoutes; extended deliberately per app onboarding —
  notably **no Secrets**, no NetworkPolicies, no PVCs until justified). Any object the PR sneaks in
  outside that envelope is rejected by the API server (RBAC), regardless of PR content. Fail-closed.
- The `ResourceSet`/`ResourceSetInputProvider` themselves live in `flux-system` and stay cluster-admin:
  their *template* is main-reviewed content (ADR 0026-consistent). The trust boundary is main-vs-PR,
  and it now maps exactly to cluster-admin-vs-`preview-applier`.
- The template injects posture into previewed workloads via Kustomization patches (main-controlled,
  applies to whatever the PR contains): `runtimeClassName: sandboxed` (ADR 0027),
  `automountServiceAccountToken: false`, `priorityClassName: bretagne-low`, and HTTPRoute `parentRefs`
  retargeted to the preview listener (§3).
- SOPS decryption is **not** enabled on the preview Kustomization — a PR must never be able to decrypt
  repo secrets. Secrets a preview legitimately needs are provided by the main-reviewed template
  (`copyFrom` of explicitly listed, preview-scoped secrets only).

### 2. Honest tier-2 scope (amends "The PR becomes the unit of QA")

Tier-1 app images are only built on merge to main (ADR 0015). Therefore the in-cluster tier, as
specified (provider on `infra-k8s`), can only preview **infra-k8s PRs**: version bumps of already-built
images (Renovate) and manifest/config changes. It cannot yet preview an *application code* PR — no
image exists for unmerged code. Covering app-code PRs later requires: per-PR CI builds in app repos
(`pr-<n>-<sha>` tags), one input provider per app repo, and preview manifests templated **from main**
with only the image tag taken from the PR (which is also the safest possible shape under §1).
Until then, tier-2 scope = manifests/versions; the CI tier remains the default for everything else.

### 3. Routing — dedicated preview hosts (supersedes "Traffic Routing" header-match design)

Header-matching on production hostnames has three structural flaws found in review: (a) the SSO gate is
oauth2-proxy **as route backend** (ADR 0021), so a preview route pointing at the preview pod silently
bypasses SSO; (b) same-origin previews receive production cookies (oauth2-proxy and IdP sessions flow
to PR code); (c) attaching preview routes to prod listeners requires opening those listeners'
`allowedRoutes` to the `preview` namespace, after which a PR manifest can shadow prod paths (Gateway
API precedence: most-specific match wins).

**Decision (v3):** previews get **dedicated hostnames** `*.preview.bretagne.dev`:

- a dedicated Gateway listener (`https-preview`) with a wildcard certificate (cert-manager, DNS-01) and
  `allowedRoutes` restricted to the `preview` namespace — and it is the **only** listener that admits
  routes from `preview`. Prod listeners stay closed to it: shadowing becomes impossible by construction.
- distinct origin ⇒ no production cookie ever reaches a preview pod; preview URLs are shareable without
  header-injection tooling.
- **No public exposure before the gate exists.** Until the preview listener carries an SSO gate
  (forward-auth style — mechanism chosen at implementation), previews are reached via `kubectl
  port-forward` only (solo operator; zero new attack surface). The template's HTTPRoute retargeting
  (§1) keeps PR-defined routes inert in the meantime.

### 4. Exclusions (new)

- **The IdP is out of preview scope.** Pocket-ID stores its OIDC signing keys in its database
  (encrypted with `ENCRYPTION_KEY`); a `db-clone` preview holding the copied secret could mint tokens
  valid for every production app, and a read-only preview on a shared hostname would see prod sessions.
  Revisit only with a dedicated design (key rotation in clone, no `ENCRYPTION_KEY` copy, dedicated
  host). The body's Pocket-ID examples are illustrative only.
- **`host-admin` and `infra` profile apps** (terminal, code-server, controllers) are never previewed
  in-cluster. Preview scope = `public-app`/`private-app` workloads.

### 5. Data mechanisms (amends the db-clone/S3 rows)

- **`db-clone` bootstraps from the S3 backup (`bootstrap.recovery`), not `pg_basebackup`.** Zero load
  on the prod primary, and every clone is a free, real restore drill of the backup chain — this is the
  designed hook for automated restore testing across all CNPG apps (pocket-id, agora-pg, stremio; the
  per-app `restore-test` CronJobs remain until preview coverage subsumes them). The recovery credential
  is a **read-only** token on the backup bucket; its exposure inside the preview namespace is accepted
  (equivalent to the clone's own content), but it must never be the prod read-write key.
- **Terminology fix:** `db-clone` protects prod **integrity**, not confidentiality — a clone exposes
  *more* data than a read-only user (full dump, no grants). For confidentiality-sensitive apps the
  right preview substrate is synthetic seed data, not a clone. The body's "safe default for sensitive
  data" phrasing is retired.
- **S3 prefixing is a convention, not a control.** Previews never receive the prod R2 key (it has write
  access to the backup bucket). If a preview needs object storage, it gets a dedicated preview bucket
  with its own token (R2 tokens scope per-bucket, not per-prefix).

### 6. Namespace profile & guardrails (aligns with ADR 0024/0025/0027)

The `preview` namespace declares `platform.bretagne.dev/profile: untrusted-compute` (repository-supplied
code, per ADR 0024's own definition) with PSS `enforce: restricted`. Consequences: template-injected
`runtimeClassName: sandboxed` + `automountServiceAccountToken: false` (§1), VAP enforcement per ADR
0027 (straight to Deny here — the template guarantees compliance; CNPG-managed pods exempted). Shared
single namespace stays, with its implications made explicit: any secret placed in the namespace is
mountable by any preview pod (hence the §1 secrets allowlist), and per-PR network allows must select
pods by per-PR labels, never namespace-wide.

### 7. Quotas — numbers on a 15 Gi node (amends the unnumbered ResourceQuota)

The node runs prod at ~50 % memory with limits already overcommitted (~126 % of allocatable). The
standing guardrails are therefore sized, not just present:

| Guardrail | Value |
|---|---|
| ResourceQuota | `requests.memory: 1Gi`, `limits.memory: 2Gi`, `requests.cpu: "1"`, `limits.cpu: "2"`, `requests.storage: 10Gi`, `persistentvolumeclaims: "2"`, `pods: "10"` |
| LimitRange (per container) | default request `64Mi`/`50m`, default limit `256Mi`, max limit `1Gi` |
| Provider `filter.limit` | `3` (upstream default is 100) |
| Pod priority | `bretagne-low` via template — previews schedule only if room exists and are evicted first |

Net effect: realistically **1–2 concurrent previews with a DB clone** — accepted and intended.
`requests.storage` matters because clones land on local-path PVCs, the same disk as the control plane.

### 8. Shared-kernel caveat, amended

Preview app pods now run under the `sandboxed` RuntimeClass (gVisor, ADR 0027): a kernel-level
container escape from preview code additionally has to defeat the sandbox. This upgrades the caveat,
it does not void it — no hardware isolation on this substrate (no KVM); the microVM path and its
triggers live in ADR 0027 §7.
