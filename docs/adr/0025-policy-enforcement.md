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

## Amendments

### 2026-07-05 — first implementation

The PSA + VAP layer was implemented in `infrastructure/configs/policies/`
(`app-baseline.yaml`, `profile-specific.yaml`, alongside the pre-existing
`untrusted-compute-sandbox.yaml`) and promoted to `Deny`. The following notes
refine the Decision, Rationale, and Implementation Shape above.

1. **Implementation Shape status.** Steps 1–3 are done: profile labels on all
   namespaces (except `agent`/`code-server`, deferred — see ADR 0024 amendment 1),
   PSA levels aligned, and VAP policies added in the dedicated policy area. Steps
   4–5: the four new bindings were promoted **straight to `Deny`**, justified by
   static verification of the Git manifests rather than an observed on-cluster
   Warn/Audit cycle (no cluster access at authoring time). This is acceptable when
   a policy's subjects are fully Git-controlled; where subjects include
   runtime-generated pods, prefer an exemption (see note 3) or an observed audit
   cycle. Confirm the API-server audit annotations are clean after the first
   reconcile as a backstop, and revert the promotion commit to fall back to
   Warn/Audit if not.

2. **PSA is not re-encoded in VAP.** Where PSA `restricted` already enforces an
   invariant (privileged containers, host namespaces, `hostPath`,
   `allowPrivilegeEscalation`, capability drops), it is left to PSA and not
   duplicated in VAP. The VAP set covers only what PSA cannot express: valid
   profile value, resource requests/limits, immutable image references,
   host-admin scope, and profile↔PSA alignment. The "checks appropriate for PSA
   and VAP" list above should be read as the invariants the *layer* guarantees,
   not as a mandate to add a VAP for each — do not "complete" it with redundant
   policies.

3. **The CNPG exemption is a cross-policy pattern.** CNPG-managed pods (carrying
   the `cnpg.io/cluster` label) are treated as trusted platform software and are
   exempt from all three pod-level app policies: `untrusted-compute-sandbox`,
   `untrusted-compute-no-ambient-credentials`, and `app-workload-hygiene`. The
   operator manages its own pod shape, image, and resources; the exemption keeps
   operator-generated pods out of the `Deny` blast radius. Any new pod-level
   policy must decide explicitly whether CNPG is in scope.

4. **The resource-hygiene check is lenient by design.** `app-workload-hygiene`
   validates that the `requests`/`limits` maps are *present*, not their values,
   because the built-in `LimitRanger` mutating plugin injects the namespace's
   `LimitRange` defaults before VAP evaluates. A namespace with a `LimitRange`
   (e.g. `stremio`) therefore satisfies the check even for containers that omit
   resources. This couples the check to the companion `LimitRange` object, whose
   presence Git review / CI must ensure — already named in the "checks PSA and VAP
   do not fully solve" list.

5. **`host-admin` is enforced as no-pods.** `host-admin-no-pods` denies all pods in
   host-admin namespaces, since the only such namespace (`terminal`) carries edge
   routing and runs no pods. This is the concrete form of "host-admin workloads
   are explicitly named or namespace-scoped": a real host-admin workload is added
   by amending the policy with a named allowlist, and that amendment is the review
   gate.

6. **`platform.bretagne.dev/guardrails: ready` is not implemented**, and MUST NOT
   be added as a bare label — that is exactly the "meaningless checkbox" the
   Implementation Shape warns against. Either wire a CI check that verifies the
   companion objects (ResourceQuota, LimitRange, Cilium default-deny, ingress
   policy) and manages the label, or drop the convention. Open decision.

7. **`failurePolicy: Fail` on namespace-scoped policies.** `namespace-profile-valid`
   and `profile-psa-alignment` fail closed (security), scoped by `objectSelector`
   on the profile label so only labelled namespaces are ever evaluated — system
   namespaces are structurally exempt, so a policy-evaluation bug cannot block
   `kube-system` et al. and stall the cluster. Before adding richer CEL to a
   namespace policy, re-check that the selector still guarantees no evaluation
   error on labelled namespaces before keeping `Fail`.
