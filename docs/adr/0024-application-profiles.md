# ADR 0024 — Platform application profiles

## Status

**Accepted — 2026-07-03.** This ADR defines the platform workload profile taxonomy used by ADR 0025 and amends the namespace guardrail model introduced in ADR 0020.

## Context

This cluster hosts different classes of workloads on the same Kubernetes substrate:

- public applications exposed to the Internet;
- private applications protected by OIDC or application-native auth;
- platform infrastructure components;
- host administration entry points;
- disposable or semi-disposable runtimes that execute code supplied by users, repositories, LLM agents, or automation.

Until now, these classes were mostly implicit. ADR 0020 introduced namespace guardrails, but it deliberately relied on convention instead of a policy engine. The audit of the repository showed that this leaves several important questions underspecified:

- whether a namespace is expected to be public, private, infrastructure, admin, or untrusted compute;
- which exceptions are legitimate for each class;
- whether an application like `code-server`, `agent`, `obsidian`, or `terminal` should be treated as a normal private app, an admin surface, or an untrusted runtime;
- how future admission policies should know which standard to apply.

The taxonomy must stay small. A profile is a security contract for a workload class, not a category per application.

## Decision

Every managed application or infrastructure namespace MUST declare exactly one platform profile through the namespace label:

```yaml
platform.bretagne.dev/profile: <profile>
```

The accepted profile values are:

| Profile | Meaning |
| --- | --- |
| `public-app` | Internet-facing application namespace. The app may be unauthenticated, self-authenticated, or protected at the edge, but it should not require broad cluster or host authority. |
| `private-app` | User-facing private application namespace. Access is expected to be restricted by OIDC and/or application-native auth. The workload may handle private data, but it does not intentionally execute arbitrary user/repository/agent code and is not an admin entry point. |
| `infra` | Platform infrastructure namespace. This includes controllers, identity, networking, storage, certificate, observability, GitOps, and other services that may legitimately need elevated RBAC, privileged pods, host access, or non-standard network behavior. |
| `host-admin` | Explicit host or operator administration surface. This profile is for resources whose purpose is administrative access to the underlying host or platform, such as the terminal edge. It must remain exceptional and small. |
| `untrusted-compute` | Runtime namespace for workloads that execute user-, repository-, agent-, or automation-supplied code. The code may be disposable and containerized, but the workload is treated as hostile or semi-hostile until stronger sandboxing proves otherwise. |

Classification is based on authority and code trust, not on the product name or the fact that the service has a web UI.

Initial intended classification:

| Namespace / workload | Profile | Notes |
| --- | --- | --- |
| `agent` | `untrusted-compute` | Agent runtimes execute tool/code flows and need a stronger sandbox contract than a normal private app. |
| `code-server` | `untrusted-compute` while shell/code execution remains available | If it later becomes a read-only code browser without shell execution, automatic Git credentials, or LLM/tool execution, it can be reclassified as `private-app`. |
| `obsidian` / `obsidian-mcp` | `private-app` | This is private application data, not an admin surface. It still needs app-level hardening, especially around MCP/JWT boundaries. |
| `terminal` | `host-admin` | Host shell access is administrative by design, even when protected by OIDC. |
| `pocket-id` | `infra` | Identity is part of the platform trust chain even if it exposes a public login endpoint. |
| `flux-system`, `cilium`, `cert-manager`, `cnpg-system`, `traefik`, observability controllers | `infra` | These are platform control-plane or dataplane components. |
| ordinary authenticated apps | `private-app` | Default for private user apps that do not execute arbitrary code. |
| ordinary public apps | `public-app` | Default for public-facing apps with no special platform authority. |

Profile minimum expectations:

| Profile | Minimum posture |
| --- | --- |
| `public-app` | Pod Security Standards restricted baseline, no host namespace usage, no privileged containers, no hostPath volumes, no automatic service account token unless justified, resource requests/limits, namespace network guardrails, and narrowly scoped ingress. |
| `private-app` | Same as `public-app`, plus explicit auth model and tighter data-handling review for apps that store personal or sensitive content. |
| `infra` | Exception-driven. Elevated RBAC, privileged containers, host access, or broad network access must be tied to the component role and kept out of application namespaces. |
| `host-admin` | Explicit admin OIDC gate, smallest possible surface area, documented owner, no automatic inheritance of normal app assumptions, and review before any additional endpoint is added. |
| `untrusted-compute` | Same baseline as private apps, plus stronger isolation expectations: no ambient cluster credentials, no automatic service account token, no host mounts, no privileged mode, constrained egress, explicit persistence boundary, and future runtime sandboxing such as gVisor, Kata, or microVM-based isolation when available. |

Container isolation alone is not considered a sufficient sandbox for hostile code. A workload can be "non-admin" and still belong to `untrusted-compute` if its primary risk is arbitrary code execution.

## Consequences

This ADR intentionally keeps the profile list short:

- sensitive private data does not create a separate profile; it is handled as `private-app` plus app-level hardening;
- identity, ingress, GitOps, storage, and observability controllers are platform infrastructure, not ordinary private apps;
- `terminal` is the only current explicit `host-admin` use case;
- `agent` and the current shell-capable `code-server` shape are `untrusted-compute`, even if their long-term design uses disposable and sandboxed runtimes.

Profiles become the selector used by admission policy in ADR 0025. Once those policies are installed, creating or reconciling a namespace without a valid `platform.bretagne.dev/profile` label should fail or at least warn during rollout.

The profile label does not replace human design review. It gives the repository, CI, and Kubernetes admission a common vocabulary for deciding which checks apply.

## Amendments

### 2026-07-05 — first implementation

The profile taxonomy was applied to every managed namespace, and the ADR 0025
policy set was implemented against it. The following points were clarified or
adjusted during that rollout. They refine the Decision above; they do not reverse
it.

1. **The `untrusted-compute` label is load-bearing, not descriptive.** Applying it
   activates the ADR 0027 `untrusted-compute-sandbox` binding, which is in `Deny`
   and requires `runtimeClassName: sandboxed` on every non-CNPG pod in the
   namespace. A namespace MUST NOT receive the label until all of its pods run the
   sandboxed runtime, or admission will reject them and break the workload.
   `agent` and `code-server` are therefore classified `untrusted-compute` (as in
   the table above) but remain **unlabelled** until their sandboxed-runtime
   migration (agent F3); each namespace manifest carries a comment recording this.
   `preview` is the only labelled `untrusted-compute` namespace today, because its
   ResourceSet patches the runtime class onto every Deployment.

2. **`public-app` and `private-app` share an identical admission posture** — PSA
   `restricted` plus the same VAP bindings. The distinction is a review contract
   (auth model, data-handling review), not an enforcement boundary. Classify by
   the most-exposed surface and the least authority the workload should assume; an
   app with both a public and a gated surface takes the more conservative
   `public-app`. `stremio` is classified `public-app` on that basis.

3. **Label *presence* is enforced in CI, not admission.** Admission (the
   `namespace-profile-valid` VAP) enforces only that the label's *value* is one of
   the accepted five, scoped by `objectSelector` to namespaces that already carry
   the key. Admission cannot enforce that every managed namespace *has* the label
   without also matching system namespaces (`kube-system`, `default`, ...), which
   have no managed-vs-system marker to distinguish them. The *Consequences*
   expectation that reconciling a namespace without a valid label "should fail or
   at least warn" is therefore delegated to Git review / CI. Introducing a
   `platform.bretagne.dev/managed` marker to close this gap at admission is an open
   decision.
