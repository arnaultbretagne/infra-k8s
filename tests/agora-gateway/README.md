# agora-gateway: the vault, agora and GitHub routes, end to end

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
| A session open, the token rotated (as the kubelet swaps `..data`), then the server refusing the old token, as at its expiry | The **same** session's `tools/call` succeeds with the new token, its tools still filtered, with no restart. On a stateful route this fails with 401: agentgateway sets up a session's upstream client, credential included, once. |
| Upstream sessions | Every session the gateway opens on the server (stateless: one per message), it closes with a DELETE: none left open. |
| The gateway's log | Route `vault`, the execution, the tool. |

`agora-route.test.mjs` does the same for the `agora` route — Agora's own MCP server (`docs/specs/mcp.md` on
arnaultbretagne/agora) — with a stand-in for the server's port 8082 that records each message and the caller named:

| Case | Expected |
| --- | --- |
| `agora:read` | The message reaches the server with `x-agora-execution` set to the token's own subject, whatever the sandbox sent in it. |
| `internet` alone, `anthropic` alone, no profile; a token used from another address | 403, the server never reached. |
| `/mcp/`, `/mcp?x=1`, `/api/workstreams`, `..`, `%2e`, `PUT` | 403, the server never reached. |
| The gateway's log | Route `agora`, the execution. |

`github-routes.test.mjs` does the same for GitHub's six routes (`docs/specs/credentials.md` on arnaultbretagne/agora,
"GitHub identities"): each keeps its hostnames, matches and policies, its backend moved to a stand-in for both GitHub
hosts that records which of the refresher's tokens each request arrived with.

| Case | Expected |
| --- | --- |
| `github:A:write`, `github:A:read` | REST and git as the contributor (`github-api`, `github-git`). |
| `github:B:review` | REST — a review, a comment — and clone and fetch as the reviewer (`github-api-reviewer`, `github-git-reviewer`); a push, GraphQL, another repository: 403. |
| Write on A and review on B; write and review on A; read and review on A | Each repository its own identity; write and review: the contributor; read and review: the reads as the contributor, a review as the reviewer. |
| `internet` | What no grant covers, read with the public token (`github-api-public`, `github-git-public`); a write or a push: 403; without `internet`: 403. |
| `x-gateway-grant` forged by the sandbox | Changes nothing; never reaches GitHub. |
| A token from an older Agora, its grants naming no identity | The contributor, as before. |
| A token used from another address | 403. |
| What GitHub receives | One of the three tokens, never the sandbox's `Authorization`; the operator's PAT is on no route. |

`github-refresher.test.mjs` runs the GitHub tokens' refresher, its script as `apps/agora-gateway/github-refresher.yaml`
ships it, against a stand-in GitHub API and a stand-in API server: each App's JWT signed with its own key, its
installation token bought, a third token narrowed to the contributor's public repositories (every page listed) with
read permissions; all three written to `github-tokens` with git's Basic form and the Secret's other keys, never
logged; exit 4 a key missing, 1 refused, 2 unable to write, 3 a token that would not outlive two runs; and every file
the gateway's GitHub routes read is a key the refresher writes, on the volume the gateway mounts.

`vault-auth.test.mjs` runs obsidian-mcp v0.4.0's own `config.ts` and `auth.ts` (obsidian-stack at its tag) on the
environment `apps/obsidian` deploys. Its tokens have the shape Pocket-ID v2.18.0 gives them. It checks that:
- both tokens `agora_gateway_vault` can obtain are accepted: client_credentials, and device_code approved by an admin
  user (accepted on its audience alone);
- another client's token is refused;
- taking the id out of `MCP_ALLOWED_CLIENT_IDS` alone leaves the device_code token accepted;
- the documented revocation, the id out of both lists, refuses both tokens, and the server still starts.

`vault-refresher.test.mjs` runs the vault token's refresher, its script as `apps/agora-gateway/vault-refresher.yaml`
ships it, against a stand-in Pocket-ID and a stand-in API server: the token minted by client_credentials and
written to `vault-token` with the Secret's other keys, never logged; exit 4 without a client secret, 1 refused, 2
unable to write, 3 a token that would not outlive two runs; the client's pinned id and token duration against the
schedule; the client's secret handed to the Pocket-ID reconciler, which owns it (its own tests:
`tests/pocket-id-reconciler`, workflow `pocket-id reconciler`).

Locally (linux-amd64, Node 24):

```sh
cd tests/agora-gateway && npm ci
AGENTGATEWAY=/path/to/agentgateway-1.6.0 AGORA_GRANTS=/path/to/agora/packages/credentials/src/grants.ts npm test
```
