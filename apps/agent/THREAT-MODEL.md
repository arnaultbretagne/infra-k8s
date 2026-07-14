# Threat model — agent credential broker & loges

Companion to agent-runtime **ADR 0011** (the broker) / **ADR 0012** (capability profiles), agora **ADR
0012** (run equipment as facts), and the master execution plan `/srv/agent-broker-execution-plan.md`
(§0.2 invariants, §2.5 network, §4 security test matrix). This note documents the trust boundary and the
allowed/denied network flows the manifests in this directory must enforce.

## Trust boundary

- **`agent` (trusted).** `runtime-manager`, `website` (agora human plane), `agent-broker` front and the
  `agent-broker-claude` / `agent-broker-vault` / `agent-broker-github` adapters. Holds **all** durable
  secrets — the real Claude token, the Pocket-ID broker client secret, the GitHub App private key —
  each in its **own** adapter's SOPS Secret, mounted only in that adapter.
- **`agent-runs` (untrusted, gVisor).** The loges. **No** Secret provider, **no** private key, **no**
  ServiceAccount token. A loge holds only an **opaque per-run lease** (agent-runtime ADR 0011 §2).

Secrets never live in `agent-runs`, in `website`, or in `runtime-manager`. The manager mints/holds
leases but not provider secrets.

## Allowed network flows (CiliumNetworkPolicy)

- loges → `agent-broker` **front :8788** (data plane) — the only broker port a loge may reach;
- `runtime-manager` → `agent-broker` **front :8789** (admin plane), by ServiceAccount identity;
- `agent-broker` front → the three adapters (internal Services);
- `agent-broker-claude` → the Anthropic endpoints it needs;
- `agent-broker-vault` → Pocket-ID and the Vault MCP;
- `agent-broker-github` → `api.github.com` (+ any documented GitHub endpoints);
- loges → `website` **:8601** (channel WS only, agora ADR 0002 amendment);
- `oauth2-proxy` → `website` **:8600** (human UI/API);
- broker / adapters → kube-DNS.

## Denied network flows

- loges → broker **admin :8789** (mint/revoke is manager-only);
- loges → the adapters directly (front is the only entry);
- loges → `website` **:8600** (human plane — closed in P1 step B);
- ingress gateway / public internet → the broker (no public route at all);
- `website` → broker admin or data;
- broker → the Kubernetes API (no SA reach) unless a later, explicit justification is added.

## Threats & mitigations

| Threat | Mitigation |
|---|---|
| **Stolen lease** exfiltrated from a loge | Opaque, per-run, time-bounded, revocable; store keeps `hash(token)` only; revoked on kill/reap/crash/orphan-cleanup |
| **Replayed lease** after run end | Revocation on every teardown path; expiry ≤ absolute lifetime; adapter revalidates before touching a provider |
| **Forged profile** (a loge asks for more) | Profile is a server-side catalogue; loge cannot set/widen it; manager is final authority (ADR 0012) |
| **Forged target** (repo A lease → repo B) | Target frozen on the lease; adapter checks target match → `409`; `infra-k8s` hard-denied in code |
| **Log poisoning / secret in logs** | Audit logs carry only `leaseId`/class fields; never bearer, `Authorization`, private key or raw provider response |
| **Spoofed pod** reaching admin/adapters | CNP by identity: only manager→admin, only front→adapters, only loges→data |
| **Provider SSRF** (loge picks the URL) | Provider endpoints are fixed in the adapters; the loge never supplies a URL |
| **Secret in an exception** | Error responses strip any provider body that may contain a credential; stable typed error codes only |
| **Forged `aud` at Vault** | Vault MCP gates on the IdP-asserted client `sub`, not the client-forgeable `aud` (obsidian-stack PR #10) |

## Residual exposure (accepted, v1)

For a GitHub profile the broker returns a short-lived **installation access token** into the loge — a Git
HTTPS client needs a usable credential. It is readable by any process in that loge until it expires
(~1 h), scoped to one repo and the profile's permissions. Accepted as far below a PAT or the App key; a
transparent Git Smart-HTTP proxy is a possible later hardening (plan §0.3).
