# ADR 0028 — `agent-runs`: the untrusted-compute namespace for agent runtime loges

## Status

Accepted — 2026-07-05 (verrous V1–V3 passés — agent-runtime ADR 0010). Instantiates the ADR 0027
sandbox contract and an ADR 0024 profile on a new namespace; **amends ADR 0024** (classification
table + the F3 migration path).

## Context

ADR 0024 classifies the `agent` namespace `untrusted-compute` but leaves it **unlabelled**: the ADR
0027 Deny binding would reject its pods, because one pod mixes trusted control plane (the supervisor)
with untrusted compute (the claude runtimes). The runtime redesign (agent-runtime ADR 0010) dissolves
exactly that mix: per-conversation runtime pods (**loges**) move to their own namespace, created by a
trusted **manager** that stays in `agent`.

This is the second consumer of the untrusted-compute pattern after `preview` — and the proof of its
genericity: the VAP binding selects by namespace label, so **zero policy code changes**.

## Decision

### 1. Namespace, labelled from birth

`agent-runs`, carrying `platform.bretagne.dev/profile: untrusted-compute` **and** PSA
`restricted` from day one. Loges are sandboxed by construction (`runtimeClassName: sandboxed` in the
manager's pod template); there is no "label later" debt like the `agent` namespace accumulated.

### 2. The pack (mirrors `infrastructure/configs/preview/`)

At `infrastructure/configs/agent-runs/`:

- **quota.yaml** — blast-radius bound for the whole substrate (the 2026-07-04 freeze lesson), initial
  values: `pods: 5`, `requests.cpu: 1`, `requests.memory: 2Gi`, `limits.cpu: 5`,
  `limits.memory: 8Gi`. (RuntimeClass `overhead` 64Mi/pod is included in quota accounting.)
- **limitrange.yaml** — safety defaults matching the loge template (`defaultRequest` 100m/320Mi,
  `default` 1 CPU/1536Mi, `max.memory` 2Gi).
- **networkpolicy.yaml** — vanilla default-deny both directions + allow-dns (preview shape).
- **loges-cnp.yaml** — CiliumNetworkPolicy for `app=loge`: ingress = manager (ns `agent`) :8080 +
  host probes; egress = DNS + website (ns `agent`) :8600 (the channel dial-back, cross-namespace) +
  `toEntities: world` :443/:80 (Anthropic; FQDN tightening is a recorded follow-up — the standing
  Cilium justification).
- **rbac.yaml** — Role in `agent-runs`: `pods` [create, get, list, delete] + `pods/log` [get]
  (diagnostics). **No exec, no secrets.** RoleBinding to the `runtime-manager` SA (ns `agent`).
- **claude-oauth.secrets.yaml** — SOPS copy of the setup-token Secret for this namespace (Secrets are
  namespaced; the loge pods mount it by name; the manager cannot read it via the API).

### 3. The manager (in `apps/agent/`)

Deployment + Service `runtime-manager` + PVC `runtime-anchors` (1Gi local-path, the transcript
custody store). The manager pod carries the **only** ServiceAccount token in the `agent` namespace —
a documented ADR 0024 exception, scoped by §2's Role to pod CRUD in `agent-runs` and nothing else.
Pod-create authority is *not* platform authority in the ADR 0026 sense: what those pods can be is
bounded by admission (0027 VAP, PSA restricted, quota) and by what exists in the namespace (one
mountable Secret).

CNP updates in `apps/agent/networkpolicy.yaml`:

- `website` egress: + `runtime-manager` :8080 (the direct supervisor egress stays during migration,
  removed in the final phase); ingress: + loges (ns `agent-runs`) :8600.
- new `runtime-manager` policy: ingress = website :8080 + host probes; egress = DNS +
  `toEntities: kube-apiserver` :6443 + shared supervisor :8080 + loges (ns `agent-runs`) :8080.

### 4. Images

Loges run the agent-runtime image **digest-pinned** via the manager's `LOGE_IMAGE` env — interim
discipline until the immutable-tags chantier (dev-loop S1) replaces `:latest` everywhere.

### 5. End-state (separate, gated phase — amends ADR 0024's F3)

F3 is **redefined**: not "sandbox the `agent` namespace" but "**evacuate compute to `agent-runs`,
then relabel `agent`**". The gated follow-up moves the shared-substrate pod (supervisor + PVC) into
`agent-runs` as a sandboxed pod; `agent` then holds only platform components (website, oauth2-proxy,
manager, agora-pg) and relabels **`private-app`**. ADR 0024's classification table gains:

| Namespace / workload | Profile | Notes |
| --- | --- | --- |
| `agent-runs` | `untrusted-compute` (labelled) | Runtime loges + (end-state) the shared substrate pod. Sandboxed by construction. |
| `agent` (end-state) | `private-app` | Platform components only, once compute has evacuated. Manager SA = documented exception. |

## Consequences

- Second labelled `untrusted-compute` namespace; comment updates in
  `policies/untrusted-compute-sandbox.yaml` (header: "today that is preview alone" → "+ agent-runs")
  and `apps/agent/namespace.yaml` (F3 wording → this ADR).
- Quota + the manager's spawn rate-limit are the platform answer to the 2026-07-04 double-freeze
  (per-loge OOM instead of fleet-wide; no cold-start herd).
- Hardening follow-up recorded (not v1): a VAP pinning the loge pod *shape* in `agent-runs` (image
  allowlist, `automountServiceAccountToken: false`, limits required) — turning the manager's template
  from convention into admission-enforced contract.
- Rollback: the pack is inert without pods; flipping the website's `SUPERVISOR_URL` back to the
  shared supervisor instantly restores today's topology.
- **Verify gates (agent-runtime ADR 0010) passed 2026-07-05** — V1/V2 clean; V3 confirmed the loge
  egress rule (§2 `loges-cnp.yaml`) is correct via `cilium monitor` drop logs, but the loge→website
  leg cannot go green end-to-end until this ADR's §3 website-ingress amendment ships *together* with
  the loges CNP (P2, one PR) — not tested as two independently-deployable halves. Full measurements
  in `/srv/runtime-isolation-plan.RUNLOG.md`.
