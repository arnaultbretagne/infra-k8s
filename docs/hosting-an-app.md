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
   `hostnames: [myapp.bretagne.dev]` + `backendRefs: [your Service]`, and the **HSTS filter** below.
3. **DNS**: point `myapp.bretagne.dev` at the VPS IP (`85.17.246.41`).
4. **TLS is automatic** (cert-manager HTTP-01 via `letsencrypt-prod`). No manual certs.

**HTTP→HTTPS is redirected globally** (S8): a catch-all `RequestRedirect` HTTPRoute on the `http`
listener 301s every plaintext request to HTTPS. You don't add anything — it just works, and the ACME
challenge path still resolves (its exact-path route out-prioritises the `/` catch-all).

**HSTS** is per-route (Gateway API has no gateway-wide header hook; a `Strict-Transport-Security`
header is only honoured over HTTPS, so it can't live on the redirect). Add this filter to every
HTTPRoute rule:

```yaml
  rules:
    - filters:
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            set:
              - name: Strict-Transport-Security
                value: "max-age=86400; includeSubDomains"   # 1-day rollout; → 31536000 once proven. No preload.
      backendRefs:
        - name: myapp
          port: 80
```

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

## 10. Auth — the OIDC authorization model (ADR 0021 + 0022)

### 10.1 The model (read this before wiring auth)

- **One Pocket-ID client per protected app.** Own `client_id`/secret, own redirect URI, own group
  restriction. Blast radius stays per-app.
- **Pocket-ID groups are the single source of truth for *authorization*.** Membership lives in one
  place (the IdP). The client's **group restriction is the primary filter** — it fails *closed* at
  token issuance: a non-member never gets a token, so the app never sees the request. Group model
  today: `admin` (operators); `stremio-users` reserved for media consumers (see ADR 0022).
- **Authentication ≠ authorization.** A valid token only proves the user logged into Pocket-ID.
  *Restricting to a group* is what gates access. Never rely on "has a token" alone.

### 10.2 Client config is declarative — the reconciler (ADR 0022)

Clients are **not** created by hand in the admin UI (that drifts — it's how Grafana ended up open).
The desired state lives in `apps/pocket-id/oidc-reconciler/spec.json` (name, callbackURLs,
`allowedGroups`, pkce/public), reconciled into Pocket-ID by a daily CronJob hitting the API.

- **Bijective**: a client/group **not** in the spec is **pruned**. Adding an app = add its block.
- It manages **policy only, never secrets**. A brand-new client's secret is minted by Pocket-ID at
  creation — copy it **once** into that app's SOPS by hand (the reconciler never writes secrets).
- `allowedGroups` non-empty ⇒ the client is group-restricted; empty ⇒ public. **You never set the
  restriction flag yourself** — the reconciler derives it (see gotcha). Run on demand after editing:
  `k0s kubectl -n pocket-id create job --from=cronjob/oidc-reconciler oidc-reconciler-manual`.
- The runner is the CNPG postgres image already in the ns (`python3`, non-root) — no dedicated image.

### 10.3 Enforcement point — pick by app type (the group is always the knob)

| App type | Where the token is checked | What you build |
|---|---|---|
| **No native OIDC** (code-server, agent) | **oauth2-proxy** in front | `HTTPRoute → oauth2-proxy (Service) → app`; `OAUTH2_PROXY_ALLOWED_GROUPS: <group>` (belt-and-suspenders on top of the IdP restriction). Copy `apps/code-server/oauth2-proxy.yaml`. |
| **Native OIDC** (Grafana) | The **app** speaks OIDC | Restrict the Pocket-ID client to the group (access) **and** configure the app's own group→role map (privilege). Both. |
| **OAuth resource server** (obsidian-mcp / MCP) | The **app** validates JWTs itself | Must verify **`issuer` + `audience`** and check a **group/scope claim** — not just the signature. (See the live gap in `/srv/obsidian-mcp-auth-todo.md`: audience + group check missing.) |
| **Host-level** (terminal) | **systemd oauth2-proxy on the host** | Selector-less `Service` + manual `EndpointSlice` → host `:4180`; the proxy carries `OAUTH2_PROXY_ALLOWED_GROUPS=admin`. Firewall the port to the pod CIDR. |

**oauth2-proxy specifics** (ADR 0021): runs the OIDC flow against `id.bretagne.dev`; `client_id` +
`client_secret` + `cookie_secret` in SOPS; **never** leave `EMAIL_DOMAINS=*`. Pocket-ID doesn't set
`email_verified` → set `INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL=true`. To use `ALLOWED_GROUPS` the
`groups` claim must flow → put `groups` in `OAUTH2_PROXY_SCOPE` (verified working on terminal).

### 10.4 Adding a protected app — the sequence

1. Add the client block to `spec.json` (`allowedGroups: [admin]` for operator apps).
2. Run the reconciler (command above); it creates the client group-restricted.
3. Read the minted `client_secret` from Pocket-ID, put it in the app's SOPS secret.
4. Wire the enforcement point per the table (oauth2-proxy for most; native/resource-server if the app
   does OIDC itself).
5. Verify a **non**-member gets `403`/redirected — not just that *you* get in.

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
  Set CNPG WAL/retention + Prometheus `retentionSize`; watch disk. (Also: local-path PVs are hostPath,
  so kubelet exposes **no `kubelet_volume_stats_*`** for them — you can't alert per-PVC, only node-`/`.)
- **local-path + `fsGroup` = no-op** — those PVs are hostPath-backed and kubelet skips fsGroup on hostPath.
  A non-root app with a local-path PVC therefore can't write its freshly-provisioned dir (created
  `root:shared`) and EACCESes. Fix: a small **root `initContainer` that `chown -R <uid>:<gid>` the mount**
  every start (idempotent, rebuild-safe) — put `runAsNonRoot/runAsUser` on the app container (not the pod)
  so the root init is allowed, and reuse the in-cluster CNPG image (has `chown`). See `apps/stremio`.
  fsGroup still works for `emptyDir`, so keep it there.
- **Prometheus/Alertmanager images are distroless** — use `promtool`, not `wget`.
- **PSS `restricted` needs `seccompProfile: RuntimeDefault`** explicitly — the #1 rejection.
- **Memory limits are ~126% overcommitted** — big new limits raise real OOM risk; size requests to
  reality, set a sane limit, set priority.
- **Changing a CNPG `Cluster`'s resources restarts PG** — a single instance = a brief app blip; sequence it.
- **Listing a Pocket-ID client's allowed groups does NOT restrict it** — the `isGroupRestricted` flag
  must also be true, else the group list is ignored and *any* user gets in (this is how Grafana stayed
  open). The reconciler derives the flag from `allowedGroups`; if you ever touch a client by hand, set
  both.
- **A JWT resource server that checks only signature + issuer is under-gated** — without an `audience`
  check, a token minted for *another* client on the same issuer is accepted (cross-client confusion);
  without a group/scope check it's auth-without-authz. Verify issuer **and** audience **and** a group
  claim (the obsidian-mcp gap, `/srv/obsidian-mcp-auth-todo.md`).
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
- [ ] `HTTPRoute` + Gateway listener; DNS record; TLS via cert-manager (automatic); **HSTS filter**
- [ ] `CiliumNetworkPolicy` default-deny + allow-list (DNS always; no flux-system/apiserver egress)
- [ ] If DB: CNPG `Cluster` (bounded) + `ScheduledBackup` (6-field cron!) + **restore-test**
- [ ] If protected: Pocket-ID **client in `spec.json`** (reconciled, group-restricted) + secret in SOPS;
      enforcement point chosen per §10.3; a **non-member is actually denied** (not just you let in)
- [ ] Verified out-of-band, then `200` on its hostname; kustomizations green
- [ ] Image pinned (no `:latest`); Renovate / Image-Automation wired for updates
