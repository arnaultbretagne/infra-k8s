# ADR 0027 — Sandboxed runtime for untrusted compute (gVisor RuntimeClass)

## Status

**Accepted — 2026-07-04.** Implements the "future runtime sandboxing when available" expectation of ADR 0024, and amends the shared-kernel caveat of ADR 0017 (v3).

## Context

Several workload classes on this single node execute code that is not fully trusted, on the same kernel as the IdP and its database:

- **Agent runtimes** (`agent` namespace, profile `untrusted-compute` per ADR 0024) — Claude runtimes executing LLM-generated code and tool calls with `--dangerously-skip-permissions`. ADR 0024 classifies this as "hostile or semi-hostile until stronger sandboxing proves otherwise".
- **Previews** (ADR 0017) — our own unreviewed, in-flight PR code.
- Future disposable compute the agent platform may spawn.

Today the platform bounds these at the network (Cilium default-deny, ADR 0020), resource (quota/limits), API (no SA tokens) and pod-posture (PSS restricted) layers — but **not at the kernel**. ADR 0017 states this plainly: a container escape reaches the host. ADR 0024 names the fix ("gVisor, Kata, or microVM-based isolation when available") without providing it. This ADR provides it.

**The hardware constraint (verified empirically 2026-07-04):** the VPS has no `/dev/kvm` and its virtualized CPU exposes neither `vmx` nor `svm` — the provider does not enable nested virtualization (CloudStack-based multi-tenant offer; not a customer toggle). Every KVM-based isolation option — Kata Containers with any VMM (QEMU, Cloud Hypervisor, **Firecracker**), or raw microVMs — **cannot run on this machine**. These options are not rejected on merit; they are unavailable on the current substrate.

gVisor requires no hardware virtualization: its `systrap` platform intercepts the workload's syscalls in a userspace kernel (the Sentry), and the host kernel only ever sees a small seccomp-filtered syscall surface from the Sentry itself. It is used in production for exactly this workload class by GKE Sandbox, Cloud Run (gen1) and Modal.

## Decision

1. **gVisor (`runsc`) is the platform's sandbox runtime**, integrated as a containerd runtime on the k0s node (drop-in `/etc/k0s/containerd.d/`).

2. **It is exposed as a RuntimeClass named by intent, not by implementation:**

   ```yaml
   apiVersion: node.k8s.io/v1
   kind: RuntimeClass
   metadata:
     name: sandboxed
   handler: runsc
   overhead:
     podFixed:
       memory: 64Mi
       cpu: 20m
   ```

   The **name is the stable contract** — manifests, templates and policy reference `runtimeClassName: sandboxed`. The handler is a property of the current machine: if the substrate ever provides KVM, the handler swaps to Kata (Cloud Hypervisor by default, Firecracker to be benchmarked) with no change to workloads or policy.

3. **Scope — who must run sandboxed:**

   | Workload class | Sandboxed? | Why |
   |---|---|---|
   | `untrusted-compute` pods (agent runtimes) | **Mandatory** (after migration gate below) | LLM-driven code execution — the class this ADR exists for |
   | Preview app pods (ADR 0017 v3) | **Mandatory** — injected by the preview template | Unreviewed PR code next to prod |
   | CNPG instances, incl. preview `db-clone` pods | No | Upstream PostgreSQL operated by CNPG is trusted *software* processing untrusted *data*; sandbox the PR code, not the infrastructure it uses. (CNPG-under-gVisor is also unvalidated.) |
   | `infra` profile (controllers, CNI, Flux, Traefik…) | No | Platform components, often need host features |
   | `public-app` / `private-app` | No | Trusted own services; revisit per-app if one ever executes user-supplied code |
   | `host-admin` (terminal, code-server) | No — **and never treated as "safe because sandboxed"** | They are admin surfaces by design; a sandbox must not launder their authority |

4. **Enforcement via admission policy (ADR 0025):** a ValidatingAdmissionPolicy bound to namespaces labelled `platform.bretagne.dev/profile: untrusted-compute` requires pods to set `runtimeClassName: sandboxed` (with an explicit exception for CNPG-managed pods). Rollout per ADR 0025 discipline: **Audit/Warn first, Deny once the namespace's workloads are compliant.** The `preview` namespace can go straight to Deny (its template guarantees compliance); the `agent` namespace flips to Deny only after the migration gate below.

5. **Migration gate for existing agent workloads — measure before enforcing.** Before `agent` pods are switched to `sandboxed`, run the A/B benchmark (same representative workload with and without the RuntimeClass — `npm install`-class, `git clone`-class, and the heaviest real agent flow available) and record the numbers in this ADR. Expected and acceptable: ~10–40 % on syscall-heavy bursts, invisible at session level (sessions are inference-dominated). This turns "does it slow the agents down?" from a fear into a measurement.

6. **`runsc` is host substrate, managed like k0s itself (ADR 0015, 2026-07-04 amendment):** version pinned as `RUNSC_VERSION` in `bootstrap/bootstrap.sh`, installed by the bootstrap script, updated via a supervised deliberate apply (and later a Renovate custom manager). It is *below* what Flux manages; the RuntimeClass and policies above are normal GitOps objects.

7. **Escalation criteria — when this ADR stops being the answer.** Move to microVM isolation (KVM-capable machine — realistically bare metal — plus Kata; Cloud Hypervisor default, Firecracker benchmarked) when any of:
   - a **measured, sustained** degradation of representative agent flows that per-pod opt-out cannot reasonably absorb (guideline: >25 % wall-clock on end-to-end sessions, not on microbenchmarks);
   - the platform must run **genuinely hostile or third-party code** (multi-tenant agora);
   - platform-scale features become requirements (snapshot/restore of warm runtimes, hard tenancy).

   The exit is deliberately cheap: the RuntimeClass name survives, the handler changes. Note that a RAM-driven machine upgrade (the node froze twice on 2026-07-04 under host-side memory pressure) would deliver KVM as a side effect — capacity, not sandboxing, is the likelier trigger.

## Rationale

**Why gVisor and not Firecracker/Kata:** the hardware decides today — there is no KVM to run a VMM on (see Context). On the merits it would still be the right *first* step at this scale: one static Go binary + a containerd drop-in + one cluster object, fully reversible per-pod; elastic memory (a sandboxed pod is a normal cgroup — no static VM sizing on a 15 Gi node); and the security delta versus microVMs is marginal for *semi-hostile own agents* (industry precedent above). Firecracker's real advantages — full guest-kernel compatibility, native syscall/IO performance, snapshot/restore, hardware boundary — matter at platform scale and require KVM; they are the escalation path, not the starting point.

**Why a RuntimeClass named by intent:** the decision that must survive hardware changes is *"untrusted compute runs sandboxed"*, not *"we use runsc"*. Encoding the intent in the API contract (and the implementation in the handler) makes the future Kata swap a one-object change instead of a fleet-wide manifest edit.

**Why not the alternatives considered:**
- **Kata + any VMM** — requires KVM (unavailable). Revisit on substrate change.
- **Sysbox** — stronger-than-runc containers but the same kernel boundary class (no syscall interposition, no guest kernel); solves dev-env problems (docker-in-docker, systemd), not this ADR's problem.
- **Pod user namespaces (`hostUsers: false`)** — complementary hardening, not a substitute; requires containerd ≥ 2.0 and k0s v1.35.2 ships containerd 1.7.30. Adopt when a k0s bump brings containerd 2.x — it is nearly free and benefits *all* pods.
- **Do nothing until the machine changes** — leaves the exact gap ADR 0024 already refuses to accept for agent runtimes.

**Performance model (why the tax is acceptable here):** agent sessions are dominated by LLM inference latency; the gVisor tax applies to syscall-heavy bursts (package installs, git operations, builds) at ~10–40 % in bad cases — noise at session level. `directFS` (default) removes most historical file-IO overhead. The per-pod opt-in makes every claim testable: the same pod spec with and without `runtimeClassName` is a one-field A/B.

### Honest limits

- gVisor is **not** a hypervisor. An attacker who compromises the Sentry and then exploits the host through its reduced seccomp'd syscall surface escapes. This class of escape is rare (years of production exposure at Google-scale) but not theoretical-zero.
- **Compatibility edges exist**: `io_uring` (disabled by default), eBPF inside the sandbox, parts of `/proc`/`/sys`, ptrace-based tooling, nested container runtimes. If an agent workload breaks mysteriously *only* under the sandbox, suspect the sandbox first, use the per-pod opt-out consciously, and record it.
- **`kubectl port-forward` fails against sandboxed pods** (confirmed 2026-07-04, preview E2E test): the app is reachable and correct via direct pod-IP (`curl $PODIP:$PORT` from the node works fine), but `kubectl port-forward` gets `connection refused` — the nsenter-into-netns-then-dial-localhost mechanism kubelet uses doesn't reach the Sentry's userspace netstack the same way it reaches a runc pod's kernel netns. Use direct pod-IP access (or a Service) for debugging sandboxed pods, not port-forward.
- **CPU side channels remain**: all sandboxes share the node's cores; no core isolation on a 6-vCPU VPS. Out of scope at this threat level.
- Sandboxing **stacks on** — never replaces — the existing layers: default-deny CNP, quotas, PSS restricted, `automountServiceAccountToken: false` (ADR 0020/0024/0025).

## Consequences

- `bootstrap/bootstrap.sh` gains `RUNSC_VERSION` + the runsc/shim install + the containerd drop-in; applying it to the live node is a supervised action (containerd reload on the only node).
- `infrastructure/configs/` gains the `sandboxed` RuntimeClass and the VAP + binding (Audit first).
- The ADR 0017 preview template injects `runtimeClassName: sandboxed` into previewed Deployments (v3 amendment).
- `agent` workloads migrate to `sandboxed` after the benchmark gate; the namespace's VAP binding flips to Deny afterwards.
- `docs/hosting-an-app.md` profile table gains the runtime column (`untrusted-compute` ⇒ `sandboxed` mandatory).
- Benchmark results (A/B numbers) are recorded in this ADR when produced.
- Revisit triggers: substrate gains KVM (machine change) → Kata handler swap ADR amendment; k0s ships containerd ≥ 2.0 → adopt pod user namespaces cluster-wide.

### Benchmark results (2026-07-04, runsc release-20260622.0, `node:20-alpine`, best-of-2)

| workload | runc (`real`) | runsc (`real`) | overhead |
|---|---|---|---|
| `npm i express axios lodash` | 7s | 17s | ~140% |
| `git clone --depth 1 expressjs/express` | 1s | 1s | noise |

The npm-install number is well above the ~10–40% expected range stated above — `directFS` does not
fully absorb a burst of many small file writes at this scale. This is a **microbenchmark**, not an
end-to-end session number, so it does not by itself meet the >25% escalation criterion (§7), which is
scoped to *session-level* degradation. It does mean: don't read "10–40%" as a hard ceiling for
syscall-heavy microbenchmarks — expect package-install-class bursts to look worse in isolation than
they'll feel inside an inference-dominated agent session. Re-measure with a real agent flow before the
`agent` namespace migration gate (follow-up F3) rather than trusting this number alone.
