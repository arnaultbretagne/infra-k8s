# ADR 0020 — Network Policy & Guardrails Posture

## Status

Accepted (June 2026)

## Context

Cilium (ADR 0006) makes NetworkPolicies *enforceable*, but a CNI that *can* enforce policy is not a policy *posture*. By default every pod can reach every other pod and the open internet. Two facts make that unacceptable here:

- The cluster hosts an identity provider (Pocket-ID, ADR 0009) — compromise it and every downstream service is exposed. It and its database must be reachable only by what legitimately needs them.
- Preview-in-prod (ADR 0017) runs unreviewed PR code on the **same single node** as production and the IdP. Network segmentation is the control that bounds its blast radius.

Pod Security Standards (`docs/app-hardening.md`) constrain what a pod may do *inside itself*; they say nothing about *who talks to whom* or *what a pod may exfiltrate to*. Network policy + resource limits are the complementary, missing layer.

The posture must be safe to roll out **incrementally** — a wrong cluster-wide default-deny can break Cilium/CoreDNS/Flux and lock the operator out — and **operable by an agent**: declarative, standard, observable.

## Decision

A layered guardrail posture: **default-deny by namespace**, stamped on every namespace via a reusable bundle, rolled out high-value-namespaces-first using **Hubble audit mode** to build the allow-lists.

## Rationale

### Layers

```
host firewall (nftables, bootstrap)          — 22/80/443 public, 6443/10250 internal
  └─ Pod Security Standards (per namespace)   — no root/privileged outside the CNI
       └─ network: default-deny + allow-lists — who talks to whom, who reaches the internet
            └─ resources: ResourceQuota + LimitRange — nothing can starve the node
```

### The namespace guardrail bundle

Rather than hand-writing policy per namespace (and forgetting it), a reusable Kustomize **component** is stamped on every namespace. It applies, as one unit:

- the PSS `enforce` label (`restricted` for apps, `baseline` for infra)
- a **default-deny** NetworkPolicy (ingress + egress)
- a standing **DNS egress** allow (every workload needs it — never omitted)
- a **ResourceQuota + LimitRange**

The guardrail becomes the *default state of a namespace*, not an artisanal add-on. A namespace without the bundle is, by construction, not usable.

### Pragmatic rollout (not everything at once)

A cluster-wide default-deny applied blind can brick the platform. Order by value/risk:

1. **Workload namespaces first** — `pocket-id`, `preview`, future apps. Highest value (IdP, unmerged code), lowest risk (well-understood traffic).
2. **Platform namespaces later** — `kube-system`, `flux-system`, `cnpg-system` stay permissive until their real traffic is observed and codified.

### Rollout method — Hubble audit mode

Tight egress allow-lists cannot be written blind. Hubble (enabled now — this **amends ADR 0006**, which had deferred it to the observability stack) plus Cilium **policy audit mode** gives the loop: deploy default-deny in audit (logs denials, enforces nothing) → observe real flows in Hubble for a few days → codify the allow-list → flip to enforce. The same eyes that operate the cluster (ADR 0014) build the policies.

### Allow-list design

- Plain `NetworkPolicy` for L3/L4 (portable, simple) — the common case.
- `CiliumNetworkPolicy` only where it earns it: **FQDN egress** (R2 backups, GitHub, Let's Encrypt) and L7/DNS filtering.

### What we are deliberately NOT doing yet

- **No policy engine (Kyverno/Gatekeeper)** to *enforce* "no namespace without the bundle". For a solo, agent-operated cluster, bundle + convention + the agent checking is enough. Add one only if drift becomes real.
- **No fine-grained in-cluster RBAC.** Flux runs effectively cluster-admin. Scoping that is a real but separate hardening — a future ADR, not this one.

## Consequences

- Every namespace carries the bundle (PSS + default-deny + DNS egress + quota/limits)
- `pocket-id` / `preview` / app namespaces get default-deny + explicit allow-lists first; platform namespaces follow after observation
- **Hubble is enabled** (~100-150MB, amends ADR 0006) — used in audit mode to build allow-lists, later feeding Grafana (ADR 0014)
- **`flux-system` PSS is raised from `warn` to `enforce: restricted`** (it currently only warns — a gap found during this review)
- Pocket-ID egress is restricted to its PG + DNS; its PG egress to R2 (`*.r2.cloudflarestorage.com:443`) + DNS
- `preview` carries a standing default-deny + ResourceQuota; per-PR allows are injected by the ResourceSet (ADR 0017)
- Adding a new external dependency means adding an explicit FQDN egress rule — a deliberate, reviewed change
- Removing MetalLB (ADR 0007 superseded) is one fewer namespace to police
- Implementation is sequenced in the migration plan, right after the cluster is brought up empty — guardrails land before app workloads
