# agora-gateway: the kubernetes route, end to end

Run by `.github/workflows/agora-gateway-kubernetes-e2e.yml`. Steps (details in the test's header):
- A real API server: kind, Kubernetes 1.36.4, with its audit log on (`kind.yaml`, `audit-policy.yaml`).
- This repository's ServiceAccount, ClusterRole and ClusterRoleBinding, applied as `kubectl kustomize apps/agora-gateway`
  renders them.
- The gateway-config of the same render, run by the agentgateway 1.6.0 release binary, its sha256 checked.
- Tokens from Agora's own `GrantSigner`, carried by Agora's bridge (`outbound.ts`), at a pinned commit of the contract's
  branch.
- kubectl 1.36.5 as in a sandbox: the bridge's `kubeconfig.yaml`, no credential, `HTTPS_PROXY` the bridge.

Each check prints what it observed (`ℹ` lines): kubectl's exit code, who refused, and what the API server's audit log
recorded (verb, path, RBAC decision, code).

## What a run shows

| Case | What the run shows |
| --- | --- |
| `kubernetes:read`: `version`, `get pods -A`, a Pod, nodes, a ConfigMap, `logs`, a watch | Each one succeeds. |
| `get secrets` (one namespace and `-A`), a node's and a Pod's `proxy/`, `--as` | 403 from the API server, naming `system:serviceaccount:agora-gateway:gateway`. |
| kubectl `exec`, `attach`, `port-forward` | Nothing runs. The request of kubectl's that reaches the API server is a `GET`, refused with 403 by the RBAC (audit). kubectl's last error is the gateway's 403. |
| WebSocket handshakes to `exec`, `attach`, `portforward` through the gateway, over HTTP/1.1 | They reach the API server; the RBAC answers 403; no 101. |
| The same exec handshake straight to the API server, with the ServiceAccount's own token | The RBAC answers 403; no 101. |
| `create`, `delete`, `patch`, `label`, `create token`, `auth can-i`, `auth whoami` | Each one fails, and no write reaches the API server. `create`, `delete`, `patch`, `label`, `create token` and `auth can-i` are refused by the gateway (`authorization failed`). Before `patch`, `label` and `auth can-i`, kubectl's preliminary `GET` does reach the API server and is served. `auth whoami` fails with kubectl's own message; the audit shows nothing received. The ConfigMap is unchanged. |
| The ServiceAccount's token straight to the API server (a Secret, a delete, an exec, a token); `auth can-i --as` for 20 forbidden verb–resource pairs and 8 allowed reads | The four requests are refused (`forbidden`, naming the ServiceAccount). `can-i` answers `no` to each forbidden pair and `yes` to each read. |
| `get pods -A` with no profile, `internet` alone, `anthropic` alone, and with `kubernetes:read` from another address | Refused by the gateway; the audit shows nothing received. |
| `GET /`, `/healthz`, `/livez`, `/metrics`, `/logs/`, `..`, `%2e`, `%2f` | 403 from the gateway; the audit shows nothing received. |
| Anonymous requests straight to the API server, with every RBAC object this repository deploys applied to kind (the layers Flux reconciles from it, read from `clusters/bretagne`). They go to fixed paths and to every listable resource cluster-wide. Then one `SubjectAccessReview` for `system:anonymous` per verb and resource, and per path. | Only `/version`, `/healthz`, `/livez`, `/readyz` answer 200. The authorizer allows nothing else. The Helm charts' own RBAC is not in this repository and is not applied. |
| `internet` alone, toward `localhost:443` (kind's API server) | `503 upstream call failed: Connect: invalid peer certificate: UnknownIssuer`. No anonymous request in the audit. |
| The audit log, whole run | Every kubectl request from the sandboxes is authenticated as the gateway's ServiceAccount. None as `agora` (kubectl's own `Basic`), none anonymous. The kubelet's `kube-probe` checks and the test's own anonymous probe are set aside. |
| The token renewed (a new one, the file swapped as the kubelet does), the old one revoked (its bound Secret deleted, refused by the API server) | The tunnel opened before still reads, with no new `CONNECT`. A watch opened before delivers an event before the renewal, one after, and one 15 s later, and is still open. A new session reads. The gateway process is the same. |
| A watch open, then the ClusterRoleBinding deleted, then the gateway sent SIGTERM | After the deletion, a new request gets 403 from the RBAC, while the open watch still delivers an event. After SIGTERM, the watch closes 5.0 s later, which matches agentgateway 1.6.0's default 5 s drain (`crates/agentgateway/src/config.rs`), and the next event is not delivered. |

## The runs broken on purpose

The test then runs twice more. Each run must fail. The workflow prints its failing tests, its `ℹ` lines and its
assertion messages. A test stops at its first failing assertion, so only the cases up to that one are observed.

- **`MUTATE=route`, the route's rule set to `true`:** the gateway no longer checks the profile, the address or the path.
  Four tests fail.
  - `get pods -A` with no profile, and from another address: **exit 0, `list /api/v1/pods allow 200`**. These reads go
    through: the RBAC allows them, since they are within the role.
  - `create configmap`: refused by the API server (`create … forbid 403`).
  - `GET /`: refused by the API server (`get / forbid 403`).
  - **Known limit:** reads are protected by profile and by address only by the gateway. The RBAC bounds what is read and
    refuses writes and paths outside the role. It does not know which execution asks, nor from where.
- **`MUTATE=role`, the role given `secrets` and `pods/exec` (`get`, `create`):** four tests fail.
  - `get secret` succeeds; `auth can-i get secrets --as` answers `yes`.
  - Straight to the API server, the token opens an exec: `allow 101`, and the command's output comes back.
  - Through the gateway, the same exec handshake is authorized (`allow`) but answered `400 Upgrade request required`:
    there is no 101. The gateway does not carry the WebSocket upgrade to the API server.
