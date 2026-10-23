# ADR 0017 — Preview-in-Prod for QA

## Status

Accepted (April 2026). Hardened design for single-node (v2). **Amended 2026-07-04 (v3)** — pre-implementation review: applier authority, dedicated preview hosts, IdP exclusion, data mechanisms, quotas, honest tier-2 scope. Where the amendment contradicts the body, the amendment wins.

**Amended 2026-10-23 (v4) — read v4 first.** The preview becomes an autonomous primitive: a catalogue of
previewable apps on `main`, one namespace per preview, a trusted `preview-system` namespace for
everything PR code must not read, Kata only, three data modes, and feedback on the PR. v4 is
self-contained; where it differs from the body or from v3, v4 wins. The body and v3 stay as history.

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

## Amendment 2026-10-23 — v4: the preview primitive

Designed with the operator between 2026-10-12 and 2026-10-23, on g4 (6 cores, 31 GiB, KVM) rather than
the VPS the body and v3 were written for. Nothing of v4 is built yet; §14 says what is live and what is
left. Where v4 differs from the body or from v3, v4 wins.

What stands from earlier versions: the CI tier stays the default for most PRs (body); `main`-reviewed
templates apply with platform authority and PR content only under impersonation, with no SOPS
decryption (v3 §1); the IdP is never previewed (v3 §4); a clone protects integrity, not
confidentiality, and previews never receive the production R2 key (v3 §5).

### 1. The primitive

A preview is started by a label on a pull request, and nothing else. The Flux Operator creates it,
re-renders it on every push, and removes it when the PR is closed, merged or unlabelled. No agent and
no human deploys anything.

**Who may set the label is deliberately open** (operator decision, 2026-10-21): an agent, for example a
judge deciding that a change needs a live test, may set it. The control is the envelope that `main`
puts around every preview (§4 to §10), not the identity of whoever labels. Narrowing who may label
later is a credential change (the agents' GitHub grants), never a change to the primitive.

### 2. The catalogue: what can be previewed, and how

An app is previewable only if `main` holds a catalogue entry for it. No entry, no preview, whatever
the PR or its labels say: the catalogue fails closed.

An entry is one `ResourceSetInputProvider` in `flux-system`, of type `GitHubPullRequest`, carrying the
label `preview.bretagne.dev/catalogue: "true"`, one file per app in
`infrastructure/configs/previews/catalogue/`:

- `url` is the repository whose PRs can be previewed.
- `filter.labels` is `preview/<app>` in the `infra-k8s` monorepo, where one PR may touch several apps,
  or `preview` in a repository that holds a single app.
- `filter.limit` is how many previews of that app may run at once (§10).
- `defaultValues` is the app's entry itself.

The provider exports only `id`, `sha`, `branch`, `author` and `title` for each PR; `defaultValues`
"populate the inputs when the provider response does not contain them", so every PR input of that
provider carries its app's entry. One `ResourceSet` named `previews` selects every catalogue provider
through `inputsFrom.selector` and holds the only template, which branches on the entry with
`<< if >>`. These are documented Flux Operator fields, combined; the official guide shows the
single-app case, and nothing here is code of ours.

| Entry field | Example (Miniflux) | Meaning |
|---|---|---|
| `app` | `rss` | Short name, used in the namespace and the host name |
| `repo` | `https://github.com/arnaultbretagne/infra-k8s` | The PR's repository: the workload's source with `source: pr`, and where the feedback goes (§11) |
| `source` | `pr` | `pr`: the workload manifests come from the PR commit (infra-k8s apps: version bumps, configuration). `main`: they come from infra-k8s `main` and only the image tag comes from the PR (app repositories) |
| `path` | `apps/rss/workload` | The workload folder the preview applies (§13) |
| `image` | — | With `source: main`, the image whose tag becomes the PR's full commit SHA |
| `service`, `port` | `miniflux`, `8080` | What the preview's gate forwards to |
| `urlDeployment`, `urlContainer`, `urlEnv` | `miniflux`, `miniflux`, `BASE_URL` | The Deployment, container and variable that carry the app's public URL; the template sets it to the preview's URL. Empty when the app needs none |
| `internet` | `true` | Whether the workload may reach the Internet (Miniflux fetches feeds) |
| `data` | `restore` | `none`, `empty` or `restore` (§9) |
| `dbCluster` | `miniflux-pg` | The production CNPG cluster: its `-app` Secret name, and its barman `serverName` |
| `dbName`, `dbOwner` | `miniflux`, `miniflux` | The database and its owner; the preview's `-app` Secret is generated for them |
| `backupPath` | `miniflux` | With `restore`, the folder under `s3://bretagne-pg-backups/` |
| `dbSize` | `2Gi` | Storage of the preview's database |
| `dbImage` | `ghcr.io/cloudnative-pg/postgresql:17.4` | The production cluster's PostgreSQL image. A base backup only restores into the same major version: the first `restore` preview, left on the operator's default (18), failed with "control file appears to be corrupt" |
| `_comment` | | Why the entry is acceptable; mandatory when `data: restore` and `internet: true` are combined (§9) |

Every entry declares every field, empty when unused, so the template never meets a missing key.

The catalogue lives on `main` only. Adding, widening or removing an entry is an `infra-k8s` PR that the
operator merges (ADR 0026). A PR that adds its own entry previews nothing before that merge, because
the providers Flux runs are the ones on `main`.

A PR labelled for one app applies only that app's `path`, even if it also changes other apps.

### 3. Never previewed

These apps never get an entry:

| App | Why |
|---|---|
| `pocket-id` | Its database holds the OIDC signing keys and every session (v3 §4) |
| `home-assistant` | Bound to the Zigbee stick, the LAN and the TV; its data holds tokens to real devices |
| `terminal`, `code-server`, any `host-admin` surface | Administrative by design |
| `agora-gateway` | Holds every upstream credential of the agents |
| Controllers and every `infra`-profile namespace | Cluster-wide by nature (body, Open Questions §1) |

Agora is not excluded but deferred: besides its gate's, its server holds four SOPS secrets (signing
key, grants key, log, registry pull) and creates executions in `agora-sandboxes`. Its entry needs its
own design.

### 4. One namespace per preview, and `preview-system`

Operator decision, 2026-10-23: one namespace per preview instead of the shared `preview` namespace.
v4 adds a trusted namespace beside them.

| Namespace | Profile | Holds |
|---|---|---|
| `pv-<app>-pr<n>` | `untrusted-compute`, PSS `restricted`, label `preview.bretagne.dev/preview: "true"` | The PR's workload, and from the template only: ResourceQuota, LimitRange, network policies, the applier's RoleBinding, and the credentials of the preview's own database |
| `preview-system` | `private-app`, PSS `restricted` | Everything PR code must not read: per preview its GitRepository, Kustomization, applier ServiceAccount, gate and HTTPRoute, database; and once for all the gate's OIDC secret and the read-only R2 token |
| `flux-system` | `infra` | The catalogue, the ResourceSet, the GitHub token, and per preview the notification Providers and Alerts (§11) |

Why the split:

- **The workload keeps its production names.** Services, Secrets and ConfigMaps are named as in
  production, so the manifests apply unchanged: no name suffix, and no broken references to Secrets
  that CNPG generates.
- **A pod can mount any Secret of its namespace,** whatever its RBAC. Nothing that PR code must not
  read may therefore sit in a preview namespace. That is why the gate's secret, the R2 token and
  the databases themselves live in `preview-system`, and the GitHub token in `flux-system`.
- **Each preview is isolated from the others,** which the shared namespace could not give.
- **Removal is total.** The ResourceSet removes what it generated for an input that has disappeared:
  the namespace, the database and its volume, the gate.

Objects in `preview-system` are named `<app>-pr<n>-<role>` (for example `rss-pr42-pg`).

### 5. Applier authority (refines v3 §1)

- **Who applies.** Per preview, a ServiceAccount `<app>-pr<n>-applier` in `preview-system`, bound in
  `pv-<app>-pr<n>` to the ClusterRole `preview-applier`. That role grants every verb on Deployments,
  Services and ConfigMaps, and read access to ReplicaSets (Flux's health check needs it).
- **What it cannot create.** No HTTPRoute (v3 allowed them; exposure is now template-only, §7), no
  Secret, NetworkPolicy, PersistentVolumeClaim, ServiceAccount, Role or binding, and nothing
  cluster-scoped. Anything else in the PR fails the apply at the API server.
- **The Kustomization.** It lives in `preview-system`, with `targetNamespace: pv-<app>-pr<n>`,
  `serviceAccountName` set to that applier, `prune: true`, `wait: true` and no `decryption`.
- **What the template injects** into whatever the PR contains: `runtimeClassName: kata-preview` (§6),
  `automountServiceAccountToken: false`, `priorityClassName: bretagne-low`, and the entry's URL
  variable.
- **Where the workload comes from:**
  - with `source: pr`, a GitRepository on the PR's repository at `<< inputs.sha >>`;
  - with `source: main`, a GitRepository on `infra-k8s` `main`, whose Kustomization `images` sets the
    entry's image tag to `<< inputs.sha >>`. The app's CI must push `<image>:<full commit SHA>`.
- **Every new push re-renders the preview,** because the provider reports the new SHA: the label
  authorizes the branch, not one commit. The v3 template's comment saying "the polled label
  authorizes THIS commit" was wrong. This is accepted because the envelope bounds every commit alike.

### 6. Kata only (supersedes v3 §1's `sandboxed` and ADR 0027's preview row)

Operator decision, 2026-10-21: preview workloads run under Kata (one VM per Pod; g4 has KVM),
through the RuntimeClass `kata-preview`: the same handler as `kata`, with an honest overhead.

- **The cost.** `kata-preview` declares 100m CPU and 384 Mi per Pod, which quotas count. Measured
  on 2026-10-23: an idle Kata Pod's cgroup holds 308–312 Mi before its workload. With `kata`'s
  256 Mi, the first preview (whoami, 32 Mi limit, so a 288 Mi cgroup) never started: the guest
  starved, and the Kata agent timed out on every call. Agora's sandboxes escape it with their 1 Gi
  limit; `kata` keeps its 256 Mi for them.
- **Enforcement.** A ValidatingAdmissionPolicy binding on namespaces labelled
  `preview.bretagne.dev/preview: "true"` requires exactly `kata-preview`, with no CNPG exception,
  since no database runs there.
- **Databases do not run under Kata.** Preview databases run in `preview-system` under the default
  runtime: the installed CNPG `Cluster` CRD has no `runtimeClassName` field. ADR 0027 already draws
  that line: sandbox the PR code, not the trusted software it uses.
- **The shared-kernel caveat (v3 §8) is lifted for PR code,** which now has a VM boundary. It remains
  for the databases, which run trusted software on copied data.

### 7. Exposure and the SSO gate (settles v3 §3's "mechanism chosen at implementation")

- **The listener.** A Gateway listener `https-preview`, hostname `*.preview.bretagne.dev`, serves the
  certificate `bretagne-preview-wildcard-tls` (Ready). Its `allowedRoutes` admit routes from
  `preview-system` only. No PR can create a route, and production listeners never admit one from a
  preview.
- **The host name.** Each preview is served at `pr-<n>-<app>.preview.bretagne.dev`: one DNS label,
  covered by the wildcard certificate and the wildcard DNS record that already resolve.
- **The gate.** Per preview, an oauth2-proxy in `preview-system` with the standard configuration of
  ADR 0021 (`ALLOWED_GROUPS=admin`). Its upstream is
  `http://<service>.pv-<app>-pr<n>.svc.cluster.local:<port>` and its cookie domain is the preview's
  host. It costs about 20 Mi per preview.
- **One Pocket-ID client** named `preview` in the reconciler's `spec.json`:
  - its callback is `https://*.preview.bretagne.dev/oidc/callback`, using Pocket-ID's single-label
    wildcard (installed v2.18.0; the userinfo bypass CVE-2026-28512 was fixed in 2.4.0);
  - `allowedGroups` is `[admin]`;
  - its client secret and the cookie secret sit in one SOPS Secret in `preview-system`, never in a
    preview namespace.
- **Test agents** cannot pass a browser gate. How they reach previews is decided together with "who
  may use previews". The intended direction is through the agents' gateway, never with a browser
  session.

### 8. Network

| From → to | Allowed |
|---|---|
| Traefik → a gate | The gate's port |
| A gate → Pocket-ID | HTTPS |
| A gate → its own workload | The entry's `port` |
| The host (kubelet) → a workload | Its probe ports |
| A workload → DNS | Always |
| A workload → its own database | 5432, selected by the cluster's `cnpg.io/cluster` label |
| A workload → the Internet | Only when the entry says `internet: true` |
| A workload → anything else | Denied: production namespaces, `flux-system`, the API server, other previews, other preview databases |
| A preview database → R2 | 443, for the restore |
| Anything but its own workload → a preview database | Denied |

### 9. Data modes (operator decision, 2026-10-23)

| Mode | What the template creates in `preview-system` |
|---|---|
| `none` | Nothing |
| `empty` | A CNPG cluster `<app>-pr<n>-pg` with `initdb` for `dbName` and `dbOwner`; the app migrates itself |
| `restore` | A CNPG cluster `<app>-pr<n>-pg` bootstrapped with `bootstrap.recovery` from the app's latest backup, through the Barman Cloud plugin: an ObjectStore on `s3://bretagne-pg-backups/<backupPath>` with the read-only token, `serverName` set to the production cluster's |

`restore` is the nightly restore drill, kept alive for the life of the PR. What the preview writes into
its copy never reaches production.

- **Wiring.** The template writes two Secrets with the same credentials: `<app>-pr<n>-pg-owner` in
  `preview-system`, which CNPG uses for the owner (`initdb.secret` or `recovery.secret`), and
  `<dbCluster>-app` in the preview namespace, under the name the production manifests mount, with
  the keys of a CNPG `-app` Secret. Its `uri` and `host` both carry the namespace
  (`<app>-pr<n>-pg-rw.preview-system`), so an app reading either reaches the preview's database.
  Copying CNPG's generated Secret instead (`copyFrom`) would deadlock: the ResourceSet would fail to
  render until the Secret existed, and the cluster that creates it is in the same render.
- **A derived password.** The password is derived from the app and the PR number, so every render
  is identical. It needs no secrecy: the database answers only its own workload (§8) and holds
  nothing that workload cannot already read.
- **A preview database never archives.** The template sets no WAL archiver on it. The read-only token
  is the second lock: a template mistake fails closed instead of writing into a production backup
  chain.
- **The token can read the whole bucket.** R2 scopes tokens per bucket, not per prefix, and
  `pocket-id`'s backups sit in the same bucket as every other app's. That is why the token exists only
  in `preview-system` and never in a namespace that runs PR code. v3 §5 called its exposure "equivalent
  to the clone's own content"; that was wrong.
- **What `restore` exposes.** PR code reads all of that app's production data, and an agent may set
  the label (§1). Combined with `internet: true`, it can also send that data anywhere. An entry that
  combines both therefore carries a written justification in `_comment`. Miniflux's data is feed
  subscriptions and reading history, which is accepted.
- **Disk.** The preview database's PVC is sized from the entry's `dbSize`, and local-path does not
  enforce PVC sizes (playbook gotcha). Disk is watched node-wide; 312 GB were free at the time of
  writing.

### 10. Quotas and caps (supersedes v3 §7's numbers)

| Guardrail | Value |
|---|---|
| ResourceQuota, each `pv-<app>-pr<n>` | `requests.cpu: 500m`, `requests.memory: 2Gi`, `limits.memory: 3Gi`, `pods: "6"`, `persistentvolumeclaims: "0"`, `services.loadbalancers: "0"`, `services.nodeports: "0"` |
| LimitRange, each `pv-<app>-pr<n>` | default request `25m` / `64Mi`, default limit `256Mi`, max limit `1Gi` |
| ResourceQuota, `preview-system` | `requests.memory: 2Gi`, `limits.memory: 4Gi`, `requests.storage: 20Gi`, `persistentvolumeclaims: "4"` |
| Per entry | `filter.limit: 2` |
| Whole catalogue | The sum of all entries' `filter.limit` stays at 4 or below |
| Priority | `bretagne-low` for workloads, gates and preview databases: they are evicted first |

With Kata's overhead counted, a preview realistically runs two or three pods. The node was at 51 %
memory when this was written.

### 11. Feedback on the PR

Per preview, two Alerts in `flux-system` watch its Kustomization in `preview-system` (the
notification controller allows cross-namespace event sources: it runs without
`--no-cross-namespace-refs`). They feed two notification Providers, both present in the installed
notification controller:

- `githubpullrequestcomment` keeps one comment on the PR up to date, with the preview's URL and state;
- `github` sets a commit status on the PR's SHA.

The template sets the event metadata `event.toolkit.fluxcd.io/change_request`,
`event.toolkit.fluxcd.io/commit` and `event.toolkit.fluxcd.io/preview-url`.

Both providers use one fine-grained PAT with *Pull requests* and *Commit statuses* write on the
catalogued repositories, in the Secret `preview-github` in `flux-system` only (keys `username` and
`password` for the catalogue's providers, `token` for the notification Providers). The catalogue
providers use it too: authenticated, the poll interval drops from 10 to 2 minutes.

By the operator's choice (2026-10-23), that PAT is the agents' gateway PAT. Probed without writing
anything: it may set commit statuses on `infra-k8s` and `agora` and comment on `infra-k8s` PRs. It
also grants contents write on both repositories, which is why it stays in `flux-system`, never in a
namespace with a workload (ADR 0026).

### 12. Lifecycle

| Event | What happens |
|---|---|
| The label is set | Within two minutes, the ResourceSet renders the namespace, the gate, the database, then the workload; the PR gets its comment with the URL |
| A push | The new SHA re-renders the workload; the database is kept, since nothing in it depends on the SHA |
| The label is removed, or the PR is closed or merged | The input disappears and the ResourceSet removes everything it generated for it |

The removal path is documented as the ResourceSet's garbage collection of "resources … no longer
present in the current revision". It is to be proven on the first real run.

### 13. Making an app previewable

This is done once per app, as an `infra-k8s` PR, and then never again per preview:

1. **The workload folder.** `apps/<app>/workload/` holds only Deployments, Services and ConfigMaps.
   `apps/<app>/kustomization.yaml` lists `workload` beside the production-only objects (namespace,
   SOPS secrets, CNPG cluster, backups, drill, gate, route, network policies), so production renders
   exactly as before. An empty diff of `kustomize build apps/<app>` is the proof.
2. **Configuration from the environment.** The public URL comes from one environment variable. The
   database comes from the CNPG `-app` Secret (`uri`, or `host` with `port` and `dbname`). No other
   production host name is written into the workload.
3. **The catalogue entry.**
4. **For `source: main`:** the app's CI pushes `<image>:<full commit SHA>` for every PR commit.

### 14. Status, and what is left to prove

**Built on 2026-10-23** (branch `feat/previews`):
- `infrastructure/configs/previews/`: the namespace `preview-system` and its guardrails, the
  ClusterRole `preview-applier`, the ResourceSet `previews`, the Secrets `preview-gate` and
  `preview-github`, and the catalogue with `preview-demo` (`none`) and `rss` (`restore`);
- `infrastructure/configs/policies/preview-requires-kata.yaml`;
- the listener `https-preview`;
- the Pocket-ID client `preview`, created through the API and declared in `spec.json`;
- the split of `apps/rss/workload`, with an identical production render (20 objects);
- the v3 objects retired.

The standalone Certificate `bretagne-preview-wildcard` is removed. gateway-shim issues one
Certificate per Secret that a listener references, as it does for `bretagne-tls`, and two
Certificates must never write the same Secret.

**Checked before merge:**
- the template rendered for `restore`, `none` and `empty` entries with the flux-operator CLI v0.61.0;
- every rendered object accepted by the cluster's schemas;
- every new object accepted by a server-side dry-run;
- the rss workload simulated with the template's patches (Kata, no token, low priority, `BASE_URL`
  on Miniflux only).

**The R2 token** (the operator's, *Object Read only* on `bretagne-pg-backups`) is sealed as
`preview-r2-ro` in `preview-system`. It was probed before sealing: it lists `miniflux/`, and a write
under `preview-ro-probe/` is refused with `AccessDenied`.

**To prove on the first runs:**
- that `defaultValues` ride on the PR inputs;
- that removal follows a closed PR;
- that the recovery applies the owner's password;
- that the commit status lands on the PR's SHA through the `commit` metadata;
- that the Kata pods fit their quota.

**Still open:**
- how test agents reach previews (§7);
- whether to narrow who may set the label (§1);
- Agora's entry (§3).
