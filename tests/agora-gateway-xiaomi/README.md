# agora-gateway-xiaomi: the Xiaomi MiMo Token Plan route

The proof, on the cluster's side, of the route Agora's server reads the operator's Xiaomi MiMo Token Plan consumption
through: `GET https://token-plan-ams.xiaomimimo.com/v1/platform/token_plan` (Xiaomi's "Query Token Plan Credits"),
with the `limits` grant the server signs for itself (docs/specs/credentials.md on arnaultbretagne/agora, "Limits").
The gateway sets `Authorization: Bearer` + the operator's `tp-` key, `upstream-credentials`' `xiaomi`. Run by the
`tests` workflow (`ci.sh`) when the gateway changes.

- **The configuration deployed:** `kubectl kustomize apps/agora-gateway`, its `gateway-config`, the Deployment and
  the Secret. Only the files it reads, its ports, and the backends of the routes under test (`xiaomi`, `zai`,
  `internet`) are moved to local ones: a stand-in that records the `Authorization` each request arrives with.
- **The gateway:** the agentgateway 1.6.0 release binary, its sha256 checked.
- **The tokens:** signed by the test, EdDSA with a key made for the run, with the claims the gateway reads (`iss`,
  `aud`, `exp`, `sub`, `jti`, `ip`, `grants`). Not Agora's GrantSigner: its `limits` profile names this host only from
  arnaultbretagne/agora's `feat/xiaomi-limits` on. The grant is the one that branch is to sign:
  `{ host: token-plan-ams.xiaomimimo.com, path: ^/v1/platform/token_plan$, methods: [GET] }`. No real secret.

| Case | Expected |
| --- | --- |
| The route | Reads `credentials/xiaomi` as `Bearer `, on `token-plan-ams.xiaomimimo.com` alone; its rule is `zai`'s and `antigravity`'s, character for character; `upstream-credentials` has `xiaomi`, mounted whole (agentgateway 1.6.0 does not start on a missing file). |
| A grant covering `GET /v1/platform/token_plan` (alone, beside others, the whole host, with `internet`) | 200, with `Bearer` + the key, never the caller's Authorization. |
| `POST`, `DELETE`, a query, another path, `%2f`, `..`, `%2e%2e` | 403, nothing sent on. |
| No grant, another host's, `internet` alone, another region's host, another method or path in the grant; a token used from another address | 403, nothing sent on, neither with the key nor without. |
| `zai`, `internet` | As before. |
| The key swapped as the kubelet swaps `..data` | The next request carries the new one, no restart. |
| The access log | Route `xiaomi`, the execution; never the key. |

Locally (linux-amd64, Node 24, kubectl): `bash ci.sh`, or with your own binary:

```sh
npm ci
AGENTGATEWAY=/path/to/agentgateway-1.6.0 npm test
```
