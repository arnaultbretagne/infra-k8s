# agora-gateway-antigravity: agy's routes and the Google login's refresher

The proof of the `antigravity` profile on the cluster's side (docs/specs/credentials.md on arnaultbretagne/agora,
"Antigravity"; `docs/antigravity-login.md`). Run by the `tests` workflow (`ci.sh`) when the gateway, the
antigravity pool or the offer changes.

- **The configuration deployed:** `kubectl kustomize apps/agora-gateway`, its `gateway-config` and the Deployment.
  Only the files it reads, its ports, and the backends of the routes under test (`antigravity`,
  `antigravity-userinfo`, `anthropic`, `chatgpt`, `internet`) are moved to local ones: a stand-in for Google
  that records the `Authorization` each request arrives with.
- **The gateway:** the agentgateway 1.6.0 release binary, its sha256 checked.
- **The tokens:** signed by Agora's own `GrantSigner` at afdf6f6 (`packages/credentials/src/grants.ts`, the commit
  that brought `antigravity`), with a key made for the run. No real secret.

`antigravity-routes.test.mjs`:

| Case | Expected |
| --- | --- |
| `antigravity`: `POST daily-cloudcode-pa…/v1internal:loadCodeAssist`, `:streamGenerateContent?alt=sse`, `:fetchAvailableModels`; `GET www.googleapis.com/oauth2/v2/userinfo` | 200, with `Bearer` + the mounted access token, never the sandbox's placeholder. |
| `antigravity`: `/v1internal`, `/v1internal:x/y`, `/v1/projects`, `%2f`, `..`; a `POST` or a query on the user info, `/oauth2/v3/tokeninfo`, `/drive/v3/files`; `oauth2.googleapis.com/token`, `play.googleapis.com/log`, `cloudcode-pa`, `generativelanguage` | 403, nothing sent on (C71). |
| `antigravity` + `internet` | Google's other hosts and paths leave as the sandbox sent them, never with the login; agy's routes' uncovered paths still 403 (C72). |
| No profile, `anthropic`, `chatgpt`, `internet` alone; a token used from another address | 403 on both routes. |
| The access token swapped as the kubelet swaps `..data` | The next request carries the new one, no restart (C73). |
| Every case | The gateway's files as the Deployment gives them: the Secret mounted as the kubelet mounts it, then the Deployment's own init container `antigravity-login` run as deployed, which links the routes' file to the Secret's, or writes an empty one. |
| The login's Secret empty (as Flux creates it), or absent | The gateway starts; `anthropic`, `chatgpt`, `internet` answer as before; agy's routes send an empty Bearer, never the placeholder. Empty, then filled: used with no restart. Absent, then back: used after a restart. Without the init container, agentgateway 1.6.0 does not start on a missing file (`read resource file …: No such file or directory`, seen on this test's first run). |
| The access log | Route `antigravity` / `antigravity-userinfo`, the execution. |

`antigravity-refresher.test.mjs` runs the refresher's script as `apps/agora-gateway/antigravity-refresher.yaml`
ships it, against a stand-in token endpoint and API server, in both places the refresh token may live: the SOPS
key (refreshed, written with its expiry, the Secret's other keys kept; a rotation all the same: written, exit 3)
and `antigravity-session` (preferred; a new refresh token written there first, then the access token; unable to:
exit 2, nothing half-done). Refused: exit 1, `refresh refused … invalid_grant`. No login: exit 4, Google never
asked. No token, nor agy's client secret, ever logged. And its manifests: RBAC on `antigravity-token` and
`antigravity-session` alone, get and update; the one key of `upstream-credentials`, optional; egress to
`oauth2.googleapis.com` alone.

`refresher-dns.test.mjs` runs the refresher's image (node:24-alpine, musl) in Docker with the Pod's
`/etc/resolv.conf` as the kubelet writes it (search domains of `agora-gateway`, the Pod's `dnsConfig`), against a
stand-in for Cilium's DNS proxy under the refresher's policy: the names it lists answered, every other refused
(REFUSED). As deployed (ndots:1), `oauth2.googleapis.com` is asked first and resolves; at the cluster's ndots:5,
what musl does is said (ℹ).

Locally (linux-amd64, Node 24, kubectl): `bash ci.sh`, or with your own binary and checkout:

```sh
npm ci
AGENTGATEWAY=/path/to/agentgateway-1.6.0 AGORA_GRANTS=/path/to/agora/packages/credentials/src/grants.ts npm test
```
