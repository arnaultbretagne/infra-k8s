# Hosting an app on this cluster — the one playbook

> Audience: the **infra / DevOps agent** that receives an application or service and has to make it
> run here — correctly, safely, GitOps-managed. This is *the* playbook: everything from "what kind of
> app is this" to "it's live, protected, backed-up and proven". It supersedes and folds in the old
> `app-hardening.md`.
>
> The ADRs in [`adr/`](adr/) are the *why*; this is the *how*. If an ADR contradicts reality, fix the
> ADR too. Written in English to match the ADRs — flip to French if you prefer.
>
> **Living document — last real-world calibration 2026-07-02.** The [Gotchas](#12-gotchas--hard-won)
> are traps we have actually hit; treat them as rules.

---

## 0. The mental model (read this first)

- **Everything runs through GitOps.** You do **not** `kubectl apply` app manifests. You write them
  into the `infra-k8s` repo, commit, push to `main`; **Flux** reconciles them onto the cluster.
  `kubectl`/`k0s kubectl` is for **reading** state and **out-of-band verification only**.
- **The repo is the single source of truth** (monorepo, ADR 0019). App *source code* lives in its own
  repo; only *deployment manifests* live here (ADR 0016).
- **Single node, single public IP.** k0s single-node, Cilium CNI, Traefik owns `:80/:443` via the
  node's `externalIPs`. No HA. 16GB RAM, already ~126% committed on memory limits — **size honestly**.
- **An app isn't "done" until it is hardened, network-policed, resource-bounded, backed-up (if it has
  state), auth-gated (if it's protected), and verified.** A Deployment that merely boots is ~40% of
  the job.

Flux reconciles in a **dependency chain**; your app lands in the last layer:

```
sources → controllers → crds → configs → gateway → observability → apps   ← you are here
```

Push flow: edit `infra-k8s` → commit → push `main` (via the deploy key) → Flux pulls & applies. Every
change is a commit; there is no other path to the cluster.

---

## 1. Classify the app first (ADR 0015 — the 3-tier taxonomy)

This decision changes everything downstream.

| Tier | What it is | What you build | Image |
|---|---|---|---|
| **Config-only** | A public image + config/secrets/PVC. No original code. | Only manifests in `apps/<name>/`. | Public registry, **version-pinned**; Renovate PRs the bumps. |
| **Product app** | Original source in its own repo (Dockerfile + CI). | Manifests in `apps/<name>/` **+** the app repo builds → GHCR → Flux Image Automation opens a bump PR. | `ghcr.io/arnaultbretagne/<name>`. |
| **Dropped** | A tweak that *could* be a build but needn't be. | Prefer ConfigMaps + an init-seeded PVC over minting an image. | — |

**Default to config-only.** Mint a build only if a customization genuinely can't be expressed as
ConfigMaps + an init container. (`code-server` is config-only: stock image + init installs CLIs
user-space.)

---

## 2. Where it goes & the shape of a namespace

Create `apps/<name>/` with a `kustomization.yaml` (sets the namespace, lists resources), then add
`- <name>` to `apps/kustomization.yaml`.

```
apps/<name>/
  kustomization.yaml      # namespace: <name>; resources: [...]
  namespace.yaml          # + PSS enforce label
  deployment.yaml         # securityContext, probes, resources, priorityClassName, strategy
  service.yaml
  httproute.yaml          # attach to the shared Gateway
  networkpolicy.yaml      # CiliumNetworkPolicy: default-deny + allow-list
  limitrange.yaml         # defaults safety net
  secrets.yaml            # SOPS-encrypted, only if it has secrets
  # cluster.yaml / scheduled-backup.yaml / restore-test.yaml   # only if it needs a DB
```

### Pod Security Standards — every namespace carries an enforce label

Without a label, **no** check runs — any pod (root, privileged) is admitted. Set one:

| Level | Allows | Use for |
|---|---|---|
| `restricted` | non-root, drop ALL caps, read-only fs, no priv-esc, seccomp | **Apps — the default.** |
| `baseline` | blocks hostPID/hostNetwork/privileged; still allows root | Infra components that can't (yet) run non-root. Leave a `# TODO: restricted`. |
| `privileged` | everything | **CNI / storage provisioner only.** Never an app. |

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: myapp
  labels:
    pod-security.kubernetes.io/enforce: restricted
```

Use `enforce` (rejects violating pods) — not `warn`/`audit`. If unsure a component is compliant, you
can preview with `k0s kubectl label ns <ns> pod-security.kubernetes.io/enforce=restricted --dry-run=server`.

---

## 3. Investigate the image before writing the Deployment

```bash
docker inspect <image> --format '{{.Config.User}}'                 # default user? root?
docker run --rm --entrypoint cat <image> <entrypoint-path>         # what the entrypoint does
docker run --rm --user 1000:1000 --read-only --tmpfs /tmp \
  --tmpfs <data-dir> -e ... <image>                                # does it start non-root + read-only?
```
Answer: does it support a non-root user? Which dirs does it write? Does it boot `--read-only` with
tmpfs on those paths? These answers drive the securityContext below.

---

## 4. The workload manifest

### 4.1 securityContext — mandatory, both levels

```yaml
spec:
  template:
    spec:
      # --- Pod level ---
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000            # match the image's USER
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault     # REQUIRED by PSS 'restricted' — the #1 forgotten field
      containers:
        - name: app
          # --- Container level ---
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
```

If `readOnlyRootFilesystem: true` breaks the app, mount `emptyDir` on the write paths — **never**
disable read-only:
```yaml
          volumeMounts:
            - { name: data, mountPath: /app/data }
            - { name: tmp,  mountPath: /tmp }
      volumes:
        - { name: data, emptyDir: {} }
        - { name: tmp,  emptyDir: {} }
```

### 4.2 Probes — all three when the app has a healthcheck

| Probe | Role |
|---|---|
| `startupProbe` | Protects slow starts; stops liveness from killing a booting pod. |
| `readinessProbe` | Removes the pod from the Service when not ready. |
| `livenessProbe` | Restarts a deadlocked pod. |

```yaml
          startupProbe:   { httpGet: { path: /health, port: <port> }, failureThreshold: 10, periodSeconds: 3 }
          readinessProbe: { httpGet: { path: /health, port: <port> }, periodSeconds: 10 }
          livenessProbe:  { httpGet: { path: /health, port: <port> }, periodSeconds: 30 }
```
Never put `initialDelaySeconds` on liveness — use a `startupProbe`.

### 4.3 Resources

Always set `requests` (cpu + memory) and `limits.memory`. **No `limits.cpu`** (throttling is worse
than a brief burst). The namespace `LimitRange` provides defaults, but set explicit values anyway.
```yaml
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits:   { memory: 128Mi }
```

### 4.4 Priority & rollout strategy

- **`priorityClassName`**: `bretagne-critical` if the app must survive node memory pressure (the IdP,
  anything user-facing-critical); `bretagne-low` for expendable; omit (=0) otherwise. Memory limits
  are overcommitted, so eviction *will* happen — decide who loses.
- **`strategy: { type: Recreate }`** if the app is **single-instance-only** (refuses two copies —
  Pocket-ID does). The default RollingUpdate briefly runs two pods and **deadlocks the rollout**.

---

## 5. Secrets — SOPS + age (ADR 0003)

- **Never** commit plaintext. The file must be named to match `.sops.yaml`'s regex
  (`.*secrets?\.yaml$` — e.g. `secrets.yaml`, `cnpg-s3-creds.secret.yaml`).
- `sops --encrypt --in-place apps/<name>/secrets.yaml`. Only `data`/`stringData` values are
  encrypted; keys/metadata stay diff-able. Verify with a roundtrip:
  `SOPS_AGE_KEY_FILE=/root/.config/sops/age/keys.txt sops --decrypt <file>`.
- The layer's Flux Kustomization must have `decryption.provider: sops` (the `apps` layer does).
- **Sharing one secret across namespaces** (e.g. the S3 backup key): keep it **once** in `flux-system`
  and distribute via a flux-operator **`ResourceSet` + `copyFrom`** (see §9.2). Do **not** drop a
  plain stub secret carrying the `copyFrom` annotation into a kustomization — the operator only
  honours `copyFrom` on **ResourceSet-owned** secrets (this bit us; ADR 0012).

---

## 6. Exposing it — the shared Gateway (ADR 0004 / 0008)

Everything is fronted by the one `bretagne-gateway` (namespace `traefik`), **pure Gateway API** (no
Traefik CRDs). To serve `myapp.bretagne.dev`:

1. Add a **listener** to `infrastructure/gateway/gateway.yaml` — one HTTPS block per host, all sharing
   the `bretagne-tls` secret (cert-manager adds the host as a SAN automatically). Give it a `sectionName`.
2. Add an **`HTTPRoute`** in your app → `parentRefs: bretagne-gateway` + `sectionName: <listener>` +
   `hostnames: [myapp.bretagne.dev]` + `backendRefs: [your Service]`.
3. **DNS**: point `myapp.bretagne.dev` at the VPS IP (`85.17.246.41`).
4. **TLS is automatic** (cert-manager HTTP-01 via `letsencrypt-prod`). No manual certs.

There is **no HTTP→HTTPS redirect yet** (plain HTTP 404s); if the app needs one it's a Gateway-level
change (flag it).

---

## 7. Network policy — default-deny + allow-list (ADR 0006 / 0020)

Cilium **enforces** NetworkPolicies (Flannel silently ignored them). Every app gets a
`CiliumNetworkPolicy` selecting its pods, allowing only what it needs. Cilium is default-deny for a
direction once a policy selects the endpoint for that direction.

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata: { name: myapp, namespace: myapp }
spec:
  endpointSelector: { matchLabels: { app: myapp } }
  ingress:
    - fromEndpoints: [{ matchLabels: { k8s:io.kubernetes.pod.namespace: traefik } }]   # Traefik → app
      toPorts: [{ ports: [{ port: "<app-port>", protocol: TCP }] }]
    - fromEntities: [host]                                                             # kubelet probes
      toPorts: [{ ports: [{ port: "<app-port>", protocol: TCP }] }]
  egress:
    - toEndpoints: [{ matchLabels: { k8s:io.kubernetes.pod.namespace: kube-system, k8s:k8s-app: kube-dns } }]
      toPorts: [{ ports: [{ port: "53", protocol: UDP }, { port: "53", protocol: TCP }] }]   # DNS — always
    # + its DB (toEndpoints cnpg.io/cluster=<cluster>:5432), + external HTTPS (toEntities:[world]:443)…
```
Rules of thumb: **DNS egress is never omitted**; `world` egress only as broad as truly needed (prefer
`toFQDNs`); **never** allow an app egress to `flux-system` or the kube-apiserver — that's the pivot
path we deliberately block.

---

## 8. Resources & guardrails (ADR 0020)

- Add a namespace **`LimitRange`** (`defaults`) — defaults-only (`defaultRequest` cpu/mem + `default`
  mem). It never rejects; it backstops pods that forget requests/limits.
  ```yaml
  apiVersion: v1
  kind: LimitRange
  metadata: { name: defaults }
  spec:
    limits:
      - type: Container
        defaultRequest: { cpu: 25m, memory: 64Mi }
        default:        { memory: 256Mi }
  ```
- **`ResourceQuota`**: required for the `preview` namespace (bounds untrusted PR code); optional but
  encouraged for apps. Size **above current usage + headroom**, pair with the LimitRange so every pod
  satisfies it, and verify a rollout still schedules before committing.
- Assign a **PriorityClass** (§4.4).

---

## 9. If it needs a database — CloudNativePG (ADR 0012)

One PostgreSQL **cluster per app**, in the app's namespace.

### 9.1 The Cluster
```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata: { name: myapp-pg }
spec:
  instances: 1
  monitoring: { enablePodMonitor: true }        # feeds the CNPG backup/WAL alerts
  storage: { size: 1Gi, storageClass: local-path }
  priorityClassName: bretagne-critical          # if the DB is critical
  resources:                                    # BOUND it — an unbounded PG can OOM the node
    requests: { cpu: 100m, memory: 256Mi }
    limits:   { memory: 512Mi }
  backup:
    barmanObjectStore:
      destinationPath: s3://bretagne-pg-backups/myapp   # distinct path per app
      endpointURL: https://<r2-account>.r2.cloudflarestorage.com
      s3Credentials:
        accessKeyId:     { name: cnpg-s3-creds, key: ACCESS_KEY_ID }
        secretAccessKey: { name: cnpg-s3-creds, key: SECRET_ACCESS_KEY }
      wal: { compression: snappy }
    retentionPolicy: "3d"
```
Connect the app to `myapp-pg-rw.<ns>.svc:5432` using the CNPG-generated `myapp-pg-app` secret.

### 9.2 S3 creds — via the shared ResourceSet
Add a resource entry to `apps/shared/cnpg-s3-creds.yaml` (the flux-operator ResourceSet) so
`cnpg-s3-creds` is `copyFrom`-copied into your namespace. Single source lives in
`flux-system/cnpg-s3-creds`.

### 9.3 ScheduledBackup — mind the 6-field cron
```yaml
kind: ScheduledBackup
spec:
  schedule: "0 0 3 * * *"      # 6 fields (sec min hour dom mon dow) = 03:00 DAILY.
```
`"0 3 * * *"` (5 fields) is read as **hourly at HH:03** — a real trap.

### 9.4 restore-test — an untested backup is not a backup
A CronJob that lists+restores the latest backup, boots PG **standalone**, runs a health query. The
standalone boot must neutralize CNPG's managed config (it points at `/controller/*` paths absent in a
plain pod). Copy the working one from `apps/pocket-id/restore-test.yaml`; the load-bearing bits:
```bash
barman-cloud-restore ... "$PGDATA"
chmod 700 "$PGDATA"                              # PG refuses a group-writable data dir
cat >> "$PGDATA/postgresql.auto.conf" <<PGCONF
recovery_target = immediate
recovery_target_action = promote
ssl = off                                       # certs live at /controller/certificates (absent)
archive_mode = off                              # would call /controller/manager
logging_collector = off                         # would write /controller/log
unix_socket_directories = '/tmp'
PGCONF
# prepend a trust rule (pg_hba is first-match) so the health query needs no password:
{ echo "local all all trust"; echo "host all all 127.0.0.1/32 trust"; echo "host all all ::1/128 trust"; \
  cat "$PGDATA/pg_hba.conf"; } > /tmp/hba && mv /tmp/hba "$PGDATA/pg_hba.conf"
pg_ctl -D "$PGDATA" -o "-p 5433 -c listen_addresses=localhost" start -w
psql -h localhost -p 5433 -U <appuser> -d <appdb> -c "SELECT 1"
```

---

## 10. Auth — the OIDC gate (ADR 0021)

Apps that need login sit behind **oauth2-proxy** (Gateway-API-native): `HTTPRoute → oauth2-proxy
(Service) → app`. It runs the OIDC flow against Pocket-ID (`id.bretagne.dev`). **Restrict who** with
`OAUTH2_PROXY_ALLOWED_GROUPS: <pocket-id-group>` — do not leave `EMAIL_DOMAINS=*`. `client_id` +
`client_secret` + `cookie_secret` go in SOPS. Pocket-ID doesn't set `email_verified`, so the proxy
needs `INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL=true` (documented workaround).

---

## 11. Verify before you call it done

- **Out-of-band first** (before it's on the public edge): `k0s kubectl port-forward` or `curl` with a
  `Host:` header.
- Confirm: pods `Ready`; `flux get kustomizations` all `True`; the CNP is `Valid`; backup `completed`
  + restore-test `PASSED`; the app answers `200` on its real hostname.
- **Prometheus/Grafana are the eyes.** Apps that expose metrics declare a `PodMonitor`/`ServiceMonitor`.
  Must-not-fail signals get a `PrometheusRule` (see `observability/rules.yaml`). Alerts go out by email
  (Resend); the always-firing Watchdog heartbeats **healthchecks.io** as the external dead-man's switch.
- To query Prometheus/Alertmanager from inside their (distroless) pods, use `promtool query instant
  http://localhost:9090 '<promql>'` — there is no `sh`/`wget` in those images.

---

## 12. Gotchas — hard-won

- **Single-instance apps deadlock RollingUpdate** → `strategy: Recreate` (Pocket-ID; cost a ~2-min outage).
- **`copyFrom` only works on ResourceSet-owned secrets** — a plain stub stays empty (broke backups a day).
- **CNPG `ScheduledBackup` cron is 6-field** — 5 fields silently means *hourly*.
- **local-path does NOT enforce PVC size** — a `1Gi` PVC can grow to fill the disk (a stuck WAL hit 15GB).
  Set CNPG WAL/retention + Prometheus `retentionSize`; watch disk.
- **Prometheus/Alertmanager images are distroless** — use `promtool`, not `wget`.
- **PSS `restricted` needs `seccompProfile: RuntimeDefault`** explicitly — the #1 rejection.
- **Memory limits are ~126% overcommitted** — big new limits raise real OOM risk; size requests to
  reality, set a sane limit, set priority.
- **Changing a CNPG `Cluster`'s resources restarts PG** — a single instance = a brief app blip; sequence it.
- **A Kustomization with `namespace: <x>` rewrites *every* resource's namespace** — don't put a
  `flux-system`-scoped resource (like the distribution ResourceSet) inside an app overlay.
- **SSH/host**: on a fresh build, cloud-init's `50-cloud-init.conf` can silently override hardening
  drop-ins (first-match wins), and `unattended-upgrades` does nothing without `APT::Periodic` in
  `20auto-upgrades` — both handled in `bootstrap/bootstrap.sh`, but know they're fragile.

---

## 13. Pre-merge checklist

- [ ] Classified (config-only / product-app) — §1
- [ ] `apps/<name>/` created + added to `apps/kustomization.yaml`
- [ ] Namespace with correct **PSS enforce** label
- [ ] Image investigated (non-root? read-only? write paths?)
- [ ] securityContext (pod + container: non-root, seccomp, drop ALL, read-only + emptyDir)
- [ ] `startupProbe` + `readinessProbe` + `livenessProbe`
- [ ] `resources` (requests + memory limit; **no** cpu limit)
- [ ] `priorityClassName` decided; `strategy: Recreate` if single-instance
- [ ] `LimitRange` present; `ResourceQuota` if warranted / for preview
- [ ] Secrets **SOPS-encrypted**; shared secrets via ResourceSet `copyFrom`
- [ ] `HTTPRoute` + Gateway listener; DNS record; TLS via cert-manager (automatic)
- [ ] `CiliumNetworkPolicy` default-deny + allow-list (DNS always; no flux-system/apiserver egress)
- [ ] If DB: CNPG `Cluster` (bounded) + `ScheduledBackup` (6-field cron!) + **restore-test**
- [ ] Behind **oauth2-proxy** with `allowed-groups` if it needs auth
- [ ] Verified out-of-band, then `200` on its hostname; kustomizations green
- [ ] Image pinned (no `:latest`); Renovate / Image-Automation wired for updates
