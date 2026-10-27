# agora-gateway: the vault route, end to end

The proof that the gateway's `vault` route works. There is no preview of agora-gateway (ADR 0017), so this
test, run by `.github/workflows/agora-gateway-e2e.yml` on every pull request touching the gateway, the vault
or Pocket-ID, runs the real thing:

- **The configuration deployed:** `kubectl kustomize apps/agora-gateway`, its `gateway-config`. Only these are
  moved to local ones: the files it reads, its ports, and the vault Service's address.
- **The gateway:** the agentgateway 1.6.0 release binary, its sha256 checked.
- **The tokens:** signed by Agora's own `GrantSigner` (`packages/credentials/src/grants.ts` at `AGORA_REF`),
  so the grants have the form the contract gives them (`docs/specs/credentials.md` on arnaultbretagne/agora,
  "The vault").
- **The vault:** a stand-in for obsidian-mcp 0.4.0, with its twelve tools, its prompt and one tool it could
  add. It records every message and the `Authorization` it came with.
- **Secrets:** none real. The signing key, the gateway CA and the machine token are made for the run.

What it asserts:

| Case | Expected |
| --- | --- |
| `vault:read` | `tools/list` = the six read tools, which run. The six write tools, an added tool and the prompt get HTTP 400 / `-32602` from the gateway, and the server never receives them. |
| `vault:write` | Every tool, the added one included, and the prompt. |
| `vault:read` + `vault:write`, in both orders | The grants add up: every tool and the prompt (C46). |
| `internet` alone, `anthropic` alone, no profile | 403, the server never reached. |
| A token used from another address | 403. |
| `/sse`, `/health`, `/.well-known/…`, `/mcp/`, `/mcp?x=1`, `..`, `%2e`, `%2f`, `PUT`, `PATCH` | 403. With a grant that has no path too: that one is refused by the route's own path-trick check. |
| What the server receives | The machine token only: never the sandbox's `Authorization`, never Agora's token. |
| The machine token's Secret updated, as the kubelet swaps `..data` | The new token is used, with no restart. |
| The gateway's log | Route `vault`, the execution, the tool. |

Locally (linux-amd64, Node 24):

```sh
cd tests/agora-gateway && npm ci
AGENTGATEWAY=/path/to/agentgateway-1.6.0 AGORA_GRANTS=/path/to/agora/packages/credentials/src/grants.ts npm test
```
