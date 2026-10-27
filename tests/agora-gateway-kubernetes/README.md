# agora-gateway: the kubernetes route, end to end

Run by `.github/workflows/agora-gateway-kubernetes-e2e.yml`. Steps (details in the test's header):
- A real API server: kind, Kubernetes 1.36, with its audit log on (`kind.yaml`, `audit-policy.yaml`).
- This repository's ServiceAccount, ClusterRole and ClusterRoleBinding, applied as `kubectl kustomize apps/agora-gateway`
  renders them.
- The gateway-config of the same render, run by the agentgateway 1.6.0 release binary, its sha256 checked.
- Tokens from Agora's own `GrantSigner`, carried by Agora's bridge (`outbound.ts`), at a pinned commit of the contract's
  branch.
- kubectl 1.36.5 as in a sandbox: the bridge's `kubeconfig.yaml`, no credential, `HTTPS_PROXY` the bridge.
- Then the test runs twice more, with `MUTATE=route` (the route's rule set to `true`) and `MUTATE=role` (the role given
  `secrets` and `pods/exec`). Both runs must fail.

What it asserts:

| Case | Expected |
| --- | --- |
| `kubernetes:read`: `version`, `get pods -A`, a Pod, nodes, a ConfigMap, `logs`, a watch | Answered by the API server. |
| `get secrets` (one namespace and `-A`), a node's and a Pod's `proxy/`, `--as` | 403 from the API server, to `system:serviceaccount:agora-gateway:gateway`: the RBAC. |
| WebSocket handshakes to `exec`, `attach`, `portforward`, over HTTP/1.1 as kubectl sends them (GETs the grant lets through) | They reach the API server; 403 there (RBAC); never upgraded. |
| kubectl `exec`, `attach`, `port-forward` | Refused, nothing runs: kubectl 1.36.5 ends on its SPDY fallback, a POST, which the gateway refuses. |
| `create`, `delete`, `patch`, `label`, `create token`, `auth can-i`, `auth whoami` | 403 from the gateway (POST, PUT, PATCH, DELETE); the audit log shows none reached the API server; the ConfigMap is unchanged. |
| The same refusals by the RBAC alone: the ServiceAccount's token straight to the API server; `auth can-i --as` for each forbidden verb and resource | Refused; only get, list and watch on the named resources are allowed. |
| No profile, `internet` alone, `anthropic` alone; `kubernetes:read` from another address | 403 from the gateway; the API server receives nothing. |
| `/`, `/healthz`, `/livez`, `/metrics`, `/logs/`, `..`, `%2e`, `%2f` | 403 from the gateway. |
| Anonymous requests straight to the API server, with every RBAC object this repository deploys applied to kind (the layers Flux reconciles from it, read from `clusters/bretagne`): fixed paths and every listable resource cluster-wide; then a `SubjectAccessReview` for `system:anonymous` per verb and resource, and per path (anonymous may not ask itself, so `auth can-i --list --as` is not used) | Only `/version`, `/healthz`, `/livez`, `/readyz` answer; anything else 401 or 403; the authorizer allows nothing else. The Helm charts' own RBAC is not in this repository. |
| `internet` to a name resolving to the API server, on 443 | Refused: the `internet` route checks the certificate against public roots. No anonymous request reaches the API server. |
| The audit log, whole run | Every kubectl request from the sandboxes was authenticated as the gateway's ServiceAccount; never `agora` (kubectl's own `Basic`), never anonymous. The kubelet's own `kube-probe` checks are left aside. |
| The token renewed (a new one, the file swapped as the kubelet does), the old one revoked (its bound Secret deleted, refused by the API server) | The tunnel opened before the renewal still reads, with no new `CONNECT`. A watch opened before it delivers an event before the renewal, one after it, and one 15 s later, and is still open. A new session reads. No restart. |
| Cutting reading off: a watch open, then the ClusterRoleBinding deleted, then the gateway stopped with SIGTERM, as a rollout restart stops its old Pod | Once the binding is gone, new requests are refused (RBAC 403), but the open watch still delivers events: authorization happens when a request starts. Stopping the gateway closes the watch (agentgateway 1.6.0 drains for 5 s, then closes what remains). |
