# Proposed amendments to ADR 0024 & ADR 0025

**Status: proposal — not yet applied to the accepted ADRs.**

This note collects the edits ADR 0024 (platform application profiles) and ADR
0025 (validation-only policy enforcement) need now that both have a first real
implementation in `infrastructure/configs/policies/` and on every namespace.
Each item gives the location, the current wording, the proposed change, and why.

The ADRs themselves stay accepted records; apply these as dated **Amendment**
sections at the bottom of each ADR (or fold into a follow-up ADR), rather than
rewriting the original Decision text.

---

## A. ADR 0024 — platform application profiles

### A1. Record the sandbox sequencing constraint for `untrusted-compute` (highest priority)

- **Where:** the *Initial intended classification* table and *Consequences*.
- **Current:** the table maps `agent` and shell-capable `code-server` to
  `untrusted-compute`, and *Consequences* says "`agent` and the current
  shell-capable `code-server` shape are `untrusted-compute`". Nothing warns that
  applying the label has a prerequisite.
- **Problem found in implementation:** the `untrusted-compute-sandbox` VAP
  binding (ADR 0027) is in **Deny** and requires `runtimeClassName: sandboxed`
  on every non-CNPG pod in an `untrusted-compute` namespace. Labelling `agent`
  or `code-server` *before* their pods run the sandboxed runtime would make
  admission reject those pods and break the workloads. Only `preview` is
  labelled today, because its ResourceSet patches `runtimeClassName: sandboxed`
  onto every Deployment.
- **Proposed change:** add a sentence to the classification table note and to
  *Consequences*:
  > The `untrusted-compute` label is load-bearing, not descriptive: it activates
  > the ADR 0027 sandbox Deny binding. A namespace MUST NOT receive this label
  > until all of its pods set `runtimeClassName: sandboxed` (or are CNPG-managed).
  > `agent` and `code-server` are therefore classified as `untrusted-compute` but
  > remain **unlabelled** until their sandboxed-runtime migration (agent F3); the
  > intent is recorded in a comment in each namespace manifest.
- **Why:** this is the single most important operational fact learned during
  rollout and the ADR currently reads as if the label can be applied freely.

### A2. Clarify `public-app` vs `private-app` — identical enforcement, review-only distinction

- **Where:** the profile-values table (`public-app`, `private-app` rows) and
  *Profile minimum expectations*.
- **Current:** the two rows describe different intents but the minimum-posture
  table already says `private-app` is "Same as `public-app`, plus explicit auth
  model and tighter data-handling review".
- **Problem found in implementation:** classifying `stremio` was ambiguous
  because it has both a public and an OIDC-gated surface. The deciding insight
  was that **the choice does not change admission**: PSA `restricted` and every
  VAP binding treat `public-app` and `private-app` identically. The difference is
  purely the review contract.
- **Proposed change:** add one line under the profile table:
  > `public-app` and `private-app` share an identical admission posture (PSA
  > `restricted` + the same VAP bindings). The distinction is a review contract,
  > not an enforcement boundary: pick by the most-exposed surface and the least
  > authority the workload should assume. `stremio` is classified `public-app`
  > on that basis.
- **Why:** removes a recurring classification stall and records the `stremio`
  decision.

### A3. Presence-of-label enforcement moved from admission to CI

- **Where:** *Consequences* — "creating or reconciling a namespace without a
  valid `platform.bretagne.dev/profile` label should fail or at least warn during
  rollout."
- **Problem found in implementation:** VAP cannot enforce *presence* of the label
  without denying `kube-system`, `default`, and other system namespaces, because
  admission has no way to tell a repo-managed namespace from a built-in one
  (there is no `managed-by` marker in this repo). The `namespace-profile-valid`
  policy therefore enforces only that the label's **value** is valid, scoped via
  `objectSelector` to namespaces that already carry the key.
- **Proposed change:** amend the sentence to:
  > Admission enforces that the label's *value* is valid (Deny). Enforcing that
  > every managed namespace *has* the label is delegated to Git review / CI,
  > since admission cannot distinguish a managed namespace from a system one.
  > See open decision O1 (managed-namespace marker).
- **Why:** the ADR currently promises admission-level presence enforcement that
  is deliberately not built.

---

## B. ADR 0025 — validation-only policy enforcement

### B1. Update the *Implementation Shape* checklist to reflect actual state

- **Where:** *Implementation Shape*, the 6-step "expected implementation path".
- **Proposed change:** append a status line to each step:
  1. Add profile labels — **done**, all namespaces except `agent`/`code-server`
     (deferred, see A1).
  2. Align namespace PSA — **done** (levels pre-existed; `infra`
     baseline/privileged kept as documented, namespace-scoped exceptions).
  3. Add VAP policies in a dedicated area — **done**:
     `infrastructure/configs/policies/{untrusted-compute-sandbox,app-baseline,profile-specific}.yaml`.
  4. Roll out risky policies in Warn/Audit first — **partial deviation**, see B2.
  5. Promote stable policies to Deny — **done** for the current set (see B2).
  6. Keep exceptions explicit and local — **done** (CNPG exemptions inline).

### B2. Record how Deny promotion actually happened (process deviation)

- **Where:** *Implementation Shape* steps 4–5 and *Consequences* ("New policies
  should start with audit/warn actions ... then move to deny after the repository
  is clean").
- **Problem found in implementation:** the promotion to Deny was done from
  **static verification of the Git manifests**, not from an observed on-cluster
  Warn/Audit cycle (no cluster access at authoring time). Every app-authored pod
  was enumerated and shown compliant; runtime-generated pods were removed from
  the blast radius by exemption (see B3).
- **Proposed change:** add to *Consequences*:
  > Deny promotion may be justified by static verification of the Git-managed
  > manifests when the affected pods are fully Git-controlled. For policies whose
  > subjects include runtime-generated pods, prefer either an exemption (B3) or an
  > observed on-cluster audit cycle before Deny. The Phase 4 promotion of
  > `app-baseline` and `profile-specific` was static; confirm the API-server audit
  > annotations are clean after the first reconcile as a backstop.
- **Why:** keeps the ADR honest about the rollout that occurred and sets the rule
  for next time.

### B3. Document the CNPG exemption pattern

- **Where:** *Rationale* / *Consequences*.
- **Current:** only ADR 0027's sandbox policy documents a CNPG exemption.
- **Implementation reality:** three pod-level policies now exempt CNPG-managed
  pods (`'cnpg.io/cluster' in labels`): `untrusted-compute-sandbox`,
  `untrusted-compute-no-ambient-credentials`, and `app-workload-hygiene`.
- **Proposed change:** add:
  > CNPG-managed pods are treated as trusted platform software and are exempt
  > from the pod-level app policies (sandbox, ambient-credentials, workload
  > hygiene). The operator manages its own pod shape, image, and resources; the
  > exemption keeps operator-generated pods out of the Deny blast radius. Any new
  > pod-level policy should decide explicitly whether CNPG is in scope.
- **Why:** the exemption is now a cross-policy pattern and should be a documented
  decision, not three copies of an inline comment.

### B4. Clarify that VAP does not re-encode what PSA `restricted` already enforces

- **Where:** *Rationale*, "Examples of checks that are appropriate for PSA and
  VAP" (the list includes hostNetwork/hostPID/hostIPC, privileged,
  `hostPath`, `allowPrivilegeEscalation`, capability drops).
- **Problem found in implementation:** those invariants are **already enforced**
  by PSA `restricted` on `public-app`/`private-app`/`untrusted-compute`
  namespaces. Re-encoding them as VAP would add maintenance with no new signal,
  so `app-baseline.yaml` deliberately omits them and covers only what PSA cannot
  express (valid profile value, resource requests/limits, immutable images).
- **Proposed change:** reword the list intro to:
  > These are the invariants the layer must guarantee. Where PSA `restricted`
  > already enforces one (privileged, host namespaces, `hostPath`,
  > `allowPrivilegeEscalation`, capability drops), it is left to PSA and **not**
  > duplicated in VAP. VAP covers the remainder: valid profile value, resource
  > requests/limits, immutable image references, host-admin scope, and the
  > profile↔PSA alignment invariant.
- **Why:** prevents a future contributor from "completing" the list by adding
  redundant VAPs.

### B5. Record the LimitRanger-before-VAP interaction

- **Where:** *Rationale* (near the resource-requests/limits example).
- **Implementation reality:** `app-workload-hygiene` checks only that the
  `requests`/`limits` maps are **present**, not their values, because the
  built-in `LimitRanger` mutating plugin runs before VAP and injects a
  namespace's `LimitRange` defaults. `stremio`'s `LimitRange` is what makes its
  pods compliant without every container spelling out resources.
- **Proposed change:** add a note:
  > The resource-hygiene check is intentionally lenient (map presence, not
  > values): `LimitRanger` injects `LimitRange` defaults before VAP evaluates, so
  > a namespace with a `LimitRange` satisfies the check even for containers that
  > omit resources. This couples the check to the companion `LimitRange` object,
  > which Git review / CI must ensure exists (see the "checks PSA and VAP do not
  > fully solve" list, which already names `LimitRange` presence).
- **Why:** documents a non-obvious dependency that makes the Deny safe.

### B6. Record the concrete `host-admin` enforcement shape

- **Where:** the "first policy set" bullet "host-admin workloads are explicitly
  named or namespace-scoped".
- **Implementation reality:** implemented as `host-admin-no-pods` — a **Deny on
  all pods** in host-admin namespaces, chosen because the only host-admin
  namespace (`terminal`) runs zero pods (edge glue only). Adding a real
  host-admin workload requires amending the policy with an explicit named
  allowlist.
- **Proposed change:** replace the bullet with:
  > host-admin namespaces deny all pods by default (`host-admin-no-pods`, Deny),
  > since the only such namespace carries edge routing and no pods. A real
  > host-admin workload is added by amending the policy with a named allowlist —
  > that amendment is the review gate ADR 0024 asks for.
- **Why:** the ADR's "named or namespace-scoped" was abstract; record what was
  built and why "deny all" was safe.

### B7. Resolve or drop the `guardrails: ready` convention

- **Where:** *Implementation Shape*, the `platform.bretagne.dev/guardrails: ready`
  label paragraph.
- **Implementation reality:** **not implemented.** The label appears only in the
  ADR text. Per the ADR's own warning it "must not become a meaningless
  checkbox", so it should not be added until CI actually verifies the companion
  objects (ResourceQuota, LimitRange, Cilium default-deny, ingress policy).
- **Proposed change:** mark it as an **open decision** (O2 below): either wire a
  CI check that sets/verifies the label against real companion-object presence,
  or remove the suggestion from the ADR. Do not add the bare label.
- **Why:** leaving it in the ADR as-is invites exactly the empty checkbox the ADR
  warns against.

### B8. Note the `failurePolicy: Fail` availability trade-off on namespace policies

- **Where:** *Consequences* ("A too-aggressive Deny binding can block Flux
  reconciliation").
- **Implementation reality:** `namespace-profile-valid` and
  `profile-psa-alignment` are namespace-scoped, `failurePolicy: Fail`, Deny. Fail
  means a policy-evaluation error fails **closed** and could block namespace
  reconciliation. The mitigation in place is the `objectSelector` (Exists on the
  profile label): system namespaces without the label are never matched, so a
  policy bug cannot block `kube-system` et al. CEL is kept index-safe by that
  same selector.
- **Proposed change:** add:
  > Namespace-scoped Deny policies use `failurePolicy: Fail` (fail-closed for
  > security), scoped by `objectSelector` so only profile-labelled namespaces are
  > ever evaluated; system namespaces are structurally exempt. If a namespace
  > policy ever needs richer CEL, re-check that the selector still guarantees no
  > evaluation error on labelled namespaces before keeping `Fail`.
- **Why:** records the deliberate security/availability choice and its guardrail.

---

## C. Open decisions to resolve (not yet actioned)

- **O1 — managed-namespace marker.** To enforce *presence* of the profile label
  (A3/B-first-bullet) at admission instead of only in CI, introduce a marker
  label (e.g. `platform.bretagne.dev/managed: "true"`) applied by the app/infra
  kustomizations, and a VAP that denies managed namespaces lacking a profile.
  Decision: adopt the marker, or keep presence in CI only.
- **O2 — `guardrails: ready`.** Wire a CI check that verifies companion
  guardrail objects and manages the label, or drop the convention (B7).
- **O3 — audit backstop.** Confirm API-server audit annotations for the four
  promoted policies are clean after the first post-merge reconcile (B2); revert
  the Phase 4 commit to fall back to Warn/Audit if not.

---

## D. Follow-up work outside these ADRs

- `agent` / `code-server` sandboxed-runtime migration (agent F3), which unblocks
  their `untrusted-compute` label (A1).
- Per-app preview onboarding (F2): when `preview` deploys shapes other than the
  fixed demo Deployment, re-confirm the untrusted-compute Deny policies hold for
  those shapes.
