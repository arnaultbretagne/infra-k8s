# ADR 0025 — Validation-only policy enforcement with PSA and VAP

## Status

**Accepted — 2026-07-03.** This ADR supersedes ADR 0020's "no policy engine" position with a native, validation-only enforcement layer based on Kubernetes Pod Security Admission and ValidatingAdmissionPolicy.

## Context

ADR 0020 introduced namespace guardrails but deliberately avoided Kyverno, Gatekeeper, or another policy engine. That was reasonable while the cluster was smaller and mostly operated by convention, but it leaves important design principles unenforced:

- every namespace should declare a platform profile;
- application namespaces should not accidentally drift into privileged, host-mounted, or broad-network shapes;
- untrusted compute should not get ambient cluster credentials or host access;
- host administration surfaces should remain exceptional;
- infrastructure exceptions should stay explicit instead of leaking into application namespaces.

The enforcement mechanism must fit the GitOps model. Git should remain the source of the desired object shape. Admission policy should reject invalid manifests; it should not silently rewrite, generate, or complete workloads after Flux applies them.

For that reason, this ADR chooses native validation first and does not introduce a mutating or generating policy controller.

## Decision

The cluster policy model is:

1. Use Kubernetes Pod Security Admission (PSA) for namespace-level Pod Security Standards.
2. Use Kubernetes ValidatingAdmissionPolicy (VAP) and ValidatingAdmissionPolicyBinding for profile-specific validation that can be expressed with CEL.
3. Do not install Kyverno or Gatekeeper for now.
4. Do not use mutating admission policies for workloads.
5. Do not use generating policies to create namespace guardrail resources.
6. Keep custom scripts as a last resort only when a required invariant cannot be expressed through PSA, VAP, Git review, CI validation, or a future validation-only controller.

Gatekeeper may be reconsidered later in validation-only mode if the cluster needs constraints that require richer inventory, reusable constraint templates, or cross-object checks that VAP cannot reasonably cover.

Kyverno may be reconsidered later only if the platform explicitly accepts its additional policy surface and the use case is stronger than the current need, such as image verification or mature supply-chain policy. Mutating and generating Kyverno policies remain out of scope unless a future ADR changes the GitOps contract.

## Rationale

PSA and VAP fit this repository better than a broad policy controller at this stage:

- they are native Kubernetes admission mechanisms;
- they are validation-oriented and do not mutate the workload into a different object than the one reviewed in Git;
- they avoid an additional webhook/controller dependency for the first enforcement layer;
- they can bind rules to namespace labels such as `platform.bretagne.dev/profile`;
- they are sufficient for many profile-local invariants.

Examples of checks that are appropriate for PSA and VAP:

- namespaces must declare one of the accepted profile values from ADR 0024;
- `public-app`, `private-app`, and `untrusted-compute` namespaces should use restricted Pod Security Standards;
- app pods must not set `hostNetwork`, `hostPID`, or `hostIPC`;
- app pods must not use privileged containers;
- app pods must not use `hostPath` volumes;
- app pods should set `allowPrivilegeEscalation: false`;
- app pods should drop Linux capabilities unless an exception is explicitly allowed;
- app workloads should not mount automatic service account tokens by default;
- app containers should define resource requests and limits;
- workloads should avoid mutable image tags such as `latest`;
- `host-admin` workloads must remain on a small allowlist;
- `infra` exceptions must be scoped to infrastructure namespaces, not application namespaces.

Examples of checks that PSA and VAP do not fully solve:

- proving that every namespace has its companion `ResourceQuota`, `LimitRange`, Cilium default-deny policy, and ingress policy;
- reasoning about full network reachability across multiple resources;
- verifying image signatures or external registry attestations;
- checking GitHub branch protection, deploy key scope, or repository settings;
- validating backup and restore correctness;
- validating application-level behavior such as JWT audience checks inside an MCP server;
- detecting drift in existing objects that are never updated after a new policy is installed.

Those concerns should be handled by Git review, CI validation tools, runtime monitoring, dedicated controllers, or a future ADR if they become important enough to justify more machinery.

## Implementation Shape

The expected implementation path is:

1. Add `platform.bretagne.dev/profile` labels to managed namespaces.
2. Align namespace PSA labels with the selected profile.
3. Add VAP policies in a dedicated platform policy area in Git.
4. Roll out risky policies in `Warn`/`Audit` mode first.
5. Promote stable policies to `Deny` once existing manifests are compliant.
6. Keep profile exceptions explicit and local to the policy definition.

The first policy set should focus on high-signal invariants:

- namespace profile label is present and valid;
- application profiles cannot use privileged pod features;
- untrusted compute cannot receive ambient service account tokens by default;
- host-admin workloads are explicitly named or namespace-scoped;
- infra-only exceptions cannot be used from application namespaces.

Where VAP cannot prove that a companion guardrail object exists, the repository may use a reviewable label such as:

```yaml
platform.bretagne.dev/guardrails: ready
```

That label is only useful if Git review or CI verifies the companion objects. It must not become a meaningless checkbox.

## Consequences

This ADR changes the operating model from convention-only guardrails to admission-enforced guardrails, while keeping Git as the source of truth.

It also narrows the policy engine decision:

- PSA and VAP are accepted now;
- Kyverno and Gatekeeper are not part of the current platform;
- mutation and generation are not accepted for workload policy;
- a custom script is acceptable only as a deliberately scoped fallback, not as the primary enforcement system.

Care is required during rollout. A too-aggressive `Deny` binding can block Flux reconciliation. New policies should start with audit/warn actions when they may affect existing workloads, then move to deny after the repository is clean.

Admission policy does not replace review of privileged infrastructure. It makes accidental violations harder and makes intentional exceptions visible.
