# Migration Plan — Docker-Compose → k0s

The plan to move the live Docker-Compose stacks (under `/opt`) onto the k0s cluster
described by this repo. This is the artifact that never existed the first time around —
the migration stalled at `flux bootstrap` (~April 2026) without a written plan.

## Goal & constraint

- **Goal:** run the existing apps (Pocket-ID, code-server, terminal, stremio/aiostreams,
  obsidian, beszel→observability, …) on k0s, GitOps-managed, **agent-operated** (the human
  sets direction; the agent absorbs the ops — see the observability/guardrails ADRs).
- **Hard constraint:** single VPS, **one public IP**. The Docker `reverse-proxy` stack
  currently owns `:80/:443`. k0s is installed but **not running**. k8s ingress and the Docker
  edge cannot both bind the public IP — so the network edge is a **hard flip**, not a gradual
  coexistence.

## Cutover strategy — **Big-bang**

Decision: build everything in parallel with live prod, then flip the edge in **one window**.
Rejected: gradual reverse-proxy chaining (cleaner transition but leaves hybrid cruft).

**Why big-bang is safe here:** the operator (agent) has **SSH / OS-level access**, which is
*orthogonal* to the web edge. A botched flip never locks us out — we revert from the shell.
It's a homelab (no SLA), so a short cutover window is fine. Payoff: a clean end-state.

**Mechanics:**
- During the build, the cluster runs **alongside** live prod **without serving prod traffic**:
  Traefik is exposed as a **NodePort**, and Cilium does **not** announce the public IP yet
  (`CiliumLoadBalancerIPPool` / `CiliumL2AnnouncementPolicy` prepared but unapplied).
  Apps are validated **out-of-band** — `kubectl port-forward`, `curl` with a `Host:` header,
  or a temporary high-port test hostname.
- **The flip (one window):** freeze stateful Docker apps → final data sync → stop the Docker
  `reverse-proxy` (and the migrated app containers) → apply the Cilium LB pool + L2 announcement
  for the public IP → Traefik claims `:80/:443` → verify every hostname.
- **Rollback:** restart the Docker stack and remove the Cilium L2 announcement — recoverable
  from SSH even with the web edge down.

## Phases

### Phase 0 — Manifest debt + prep (no cluster yet)
- Remove MetalLB manifests (`controllers/metallb`, `configs/metallb-config`, its layer ref).
- Add Cilium LB config (`CiliumLoadBalancerIPPool` + `CiliumL2AnnouncementPolicy` for the public
  IP) — **prepared but not applied until Phase 7**. Traefik Service = **NodePort** for transition.
- Create the **namespace guardrail bundle** Kustomize component (ADR 0020).

### Phase 1 — Cluster up, empty & green  🧱 *the real wall*
- Debug and run `bootstrap/bootstrap.sh`: k0s up, Cilium up (**Hubble on**), Flux bootstrapped,
  the full Kustomization DAG `Ready` (sources → controllers → configs → gateway → apps).
- This is where it failed before — invest here (idempotent bootstrap, understand the
  `flux bootstrap` failure).
- **Gate:** `k0s kubectl get nodes` Ready, `flux get kustomizations` all Ready, Traefik serving
  on its NodePort, Hubble flows visible. **Docker prod untouched throughout.**

### Phase 2 — Guardrails baseline (ADR 0020)
- Stamp the bundle on namespaces; default-deny + allow-lists on workload namespaces
  (`pocket-id`, `preview`, apps); Hubble **audit mode** to build the allow-lists; bump
  `flux-system` PSS `warn` → `enforce: restricted`.

### Phase 3 — Pocket-ID end-to-end (the IdP first — everything depends on it)
- Bring up Pocket-ID: CNPG cluster + S3 backup + restore-test + OIDC plugin wiring + its
  NetworkPolicies (egress → its PG + DNS only).
- **Data migration:** dump the Docker Pocket-ID DB → restore into CNPG (first pass for
  validation; **final sync happens at the flip**).
- Validate passkey login, OIDC flow, and a backup/restore cycle via out-of-band access.

### Phase 4 — Stateless apps
- stremio/aiostreams, terminal. Manifest → validate out-of-band. Easy wins, build the muscle.

### Phase 5 — Stateful apps (the named exceptions, ADR 0005)
- code-server, obsidian-livesync. `local-path` PVC + backup (restic/volsync → S3).
- **Data migration:** home dir / livesync DB (first pass; **final sync at the flip**).

> Each app in Phases 3–5 ships its **auth enforcement** (OIDC middleware, ADR 0010) as part of
> its manifests — an app isn't "done" until it is protected.

### Phase 6 — Platform completion (does not block the flip)
- Observability (replaces Beszel, ADR 0014), CI/CD automation (Image Automation + Renovate,
  ADR 0015), preview-in-prod (ResourceSet, ADR 0017), and tightening of **platform-namespace**
  NetworkPolicies using the Hubble data gathered in audit mode.

### Phase 7 — The flip + decommission
- **Rehearsal:** validate Traefik serves all hostnames correctly (test announce / NodePort +
  `Host:` headers), then revert.
- **Flip window:** freeze stateful Docker apps → final data sync (Pocket-ID DB, code-server home,
  obsidian) → stop Docker `reverse-proxy` + app containers → apply the Cilium LB pool + L2
  announcement → Traefik on `:80/:443` → verify every hostname end-to-end.
- **Decommission:** stop/remove the Docker-Compose stacks (keep backups); retire or repurpose
  `infra-control`.

## Data migrations — the risky sub-steps (backup-first, always)

| App | Move | Final sync at flip |
|---|---|---|
| **Pocket-ID** | `pg_dump` Docker DB → restore into CNPG | re-dump/restore (users, passkeys, OIDC clients accumulate until flip) |
| **code-server** | rsync `$HOME` → `local-path` PV | re-rsync delta |
| **obsidian-livesync** | copy livesync DB → PV | re-sync delta |

## Rollback model

- **Before the flip:** fully reversible — Docker prod is never touched; the cluster is built in
  parallel and validated out-of-band.
- **At the flip:** restart the Docker stack + remove the Cilium L2 announcement (from SSH).
- **Per app:** every change is a PR (the GitOps gate, ADR 0015/0016); every data migration is
  backup-first.

## Status

Phase 0 in progress (manifest debt). **Next: Phase 1 — bring the cluster up empty & green** —
the wall the first attempt hit. Nothing else is real until k0s + Flux are green.
