# agora-gateway: the previews route and the previews' gateway gate, end to end

Run by `.github/workflows/agora-gateway-previews-e2e.yml`. The setup:

- **kind** (Kubernetes 1.36.4), with:
  - Gateway API v1.6.3 (`infrastructure/sources/gateway-api.yaml`);
  - Traefik, chart 41.6.1 with the values of `infrastructure/gateway/release.yaml`, except that the Service is a NodePort on 30443 (mapped to the runner's 127.0.0.1:443) instead of the node's `externalIPs`;
  - this repository's Gateway `bretagne-gateway`, its `https-preview` listener serving a test certificate for `*.preview.bretagne.dev`;
  - the cluster's PriorityClasses.
- **One preview**, `pr-42-preview-demo`:
  - rendered from `infrastructure/configs/previews/resourceset.yaml` by flux-operator 0.61.0 (the cluster's version);
  - its two gates — the browser gate and the gateway gate, both oauth2-proxy v7.15.5 as the template sets them — and its HTTPRoute, applied as rendered;
  - one change: the gates' OIDC issuer is a stand-in in the cluster (there is no Pocket-ID in kind), which signs tokens shaped as Pocket-ID 2.18.0's;
  - the preview's app is a test app that answers with what it received;
  - the ConfigMap `preview-gateway-identities` comes from `kubectl kustomize infrastructure/configs/previews`.
- **On the runner:**
  - the agentgateway 1.6.0 release binary on the gateway-config of `kubectl kustomize apps/agora-gateway`;
  - tokens from Agora's GrantSigner, carried by Agora's bridge (`outbound.ts`), at a pinned commit of the contract's branch;
  - an `/etc/hosts` entry pointing the preview's name at kind's Traefik;
  - the gateway's roots are the runner's plus the test CA (`SSL_CERT_FILE`).
- **Not here:** Cilium (the network policies are not exercised), the node's hairpin to Traefik, and the real Pocket-ID.

Each check prints what it observed (`ℹ` lines).

## What a run shows

| Case | What the run shows |
| --- | --- |
| `previews`: a GET and a POST to the preview, the sandbox sending its own `Authorization`, `x-forwarded-user` and `x-agora-gate` | 200. The app receives `Authorization: Basic` of `client-<id>:none`, `x-forwarded-user: client-<id>` and `x-agora-gate: gateway`, the POST's body as sent. It never receives the gateway's token or the sandbox's values. |
| `previews` toward names its pattern refuses | `preview.bretagne.dev`, `x.preview.bretagne.dev`, `a.pr-42-preview-demo…`, `pr-0-…`: 403 from the gateway. `pr-42-.…` and `pr-42-preview-demo-.…`, which are not DNS names: refused by the gateway at TLS. `pr-42-a_b.…`: refused by Agora's bridge (400 to the CONNECT), before the gateway. The app receives nothing. |
| No profile, `internet` alone, `anthropic` alone; `previews` from another address | 403 from the gateway; the app receives nothing. |
| `internet` alone with `x-agora-gate: gateway` | 403 from the gateway (the `previews` route takes the name). |
| A browser straight to Traefik with `x-agora-gate: gateway` | It reaches the gateway gate, which wants the gateway's token. With no token: 401. With a forged token, another client's token, or a token with the gateway client's audience and another identity: 403. With an admin-like token for the browser client: 403. The app receives nothing. |
| The browser gate | Its Deployment, Service and network policy render exactly as on the base branch. Of the HTTPRoute's two rules, the last (no match) is the base branch's only rule; the first sends `x-agora-gate: gateway` to the gateway gate. A browser without the header: 302 to the issuer's `/authorize`, `client_id=preview`. The gateway's own token sent as a bearer without the header: 302 too; the browser gate takes no bearer. |
| The preview's namespace | No Secret rendered into it, none present. |
| The gateway's token replaced while a response is open | The response ends whole; the next request succeeds. Replaced by an invalid one: the open response ends whole, the next request is refused. A valid token back: 200, with no restart. |
| `client-<id>` taken out of `preview-gateway-identities` | The gateway's requests are refused once the kubelet has synced the ConfigMap and oauth2-proxy has reloaded it (the run prints after how long). Put back: 200 again. |
| The gateway's log | Route `previews`, the execution. |

## The runs broken on purpose

The test runs twice more; each run must fail. The workflow prints its failing tests, its `ℹ` lines and its assertions.

- **`MUTATE=route`, the `previews` route's rule set to `true`:**
  - `x.preview.bretagne.dev` passes the gateway and Traefik answers 404;
  - a sandbox with `internet` alone reaches the app (200), carrying the gateway's credential.
- **`MUTATE=gate`, the gateway gate without its identities file, taking any identity with the client's audience:**
  - a token with the client's audience and another identity reaches the app (200);
  - taking `client-<id>` out of the ConfigMap no longer refuses anything.
