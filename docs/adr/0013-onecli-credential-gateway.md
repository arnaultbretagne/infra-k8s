# ADR 0013 — OneCLI as Credential Injection Gateway

## Status

Accepted

## Context

Cluster workloads (AI agents, code-server, CI jobs) need credentials to interact with external services (GitHub, Anthropic, SaaS APIs). Today in the Docker Compose infrastructure, these credentials are managed fragily:

- The GitHub token is injected via `agent-env.sh` + `agent-token`, temporarily inserted in the git URL (`https://x-access-token:{TOKEN}@github.com/...`), then removed after each operation
- API keys (Anthropic, etc.) are stored in plaintext in `.env` files
- No isolation: a workload with access to the `.env` can read all keys

The emerging pattern recommended by Anthropic for AI agents is the **injection proxy**: an external gateway intercepts outbound requests and injects credentials at request time, without the workload ever seeing the real key.

Options evaluated: OneCLI, Wardgate, HashiCorp Vault, Infisical, Composio.

## Decision

OneCLI as the centralized credential injection gateway for the cluster.

## Rationale

### How OneCLI Works

OneCLI is a transparent MITM (Man-In-The-Middle) proxy written in Rust that intercepts outbound HTTPS connections from workloads and injects credentials on the fly:

```
Pod (agent/code-server)           OneCLI Gateway (Rust)              External API
     |                                  |                                |
     |-- CONNECT github.com:443 ------->|                                |
     |   Proxy-Auth: aoc_xxx           |                                |
     |<--------- 200 OK --------------|                                |
     |                                  |                                |
     |== TLS (cert signed by OneCLI CA)=|                                |
     |-- POST /api/... --------------->|                                |
     |   x-api-key: placeholder        |-- POST /api/... ------------->|
     |                                  |   x-api-key: sk-ant-REAL-KEY   |
     |<--- stream response ------------|<--- stream response ----------|
```

The workflow:
1. The workload makes an HTTPS request via `HTTPS_PROXY` pointing to the gateway
2. The gateway terminates TLS on the client side with a **forged certificate** signed by its own CA (ECDSA P-256, generated on the fly per hostname, cached 24h)
3. It reads the request in plaintext, matches the hostname/path against secrets stored in its vault
4. It injects the credential as an HTTP header (`Authorization`, `x-api-key`, etc.)
5. It forwards the request to the real API over TLS
6. Responses are streamed without buffering (critical for Claude SSE)

Secrets are stored AES-256-GCM encrypted in PostgreSQL, decrypted only in the Rust process at injection time.

### Why a MITM Proxy and Not Classic K8s Secrets

With classic K8s Secrets (mounted as volumes or env vars), the workload **has** the raw key. An AI agent that logs its env vars, a prompt injection that exfiltrates context, a compromised container — in all these cases, the key leaks.

With OneCLI, the workload **never has the key**. Even if compromised, it can only exfiltrate its agent token `aoc_` which is only valuable from inside the cluster (because the gateway must be reachable). Real secrets never leave the Rust process.

This is a fundamental difference for AI workloads: agents execute LLM-generated code, in a context where the prompt can be manipulated. The credential exfiltration risk is structurally higher than with traditional applications.

### Detailed Comparison

Five solutions were evaluated on the following criteria: injection pattern, credential isolation, simplicity, footprint, self-hostability, and maturity.

**OneCLI** (1.3k stars, Apache-2.0, chosen):
- Transparent MITM proxy — workloads only need `HTTPS_PROXY` + the CA cert
- Integrated vault encrypted AES-256-GCM, secrets never exposed to workloads
- Multi-tenant: each workload has its own agent token `aoc_` with scopes (`selective` mode per secret) and policy rules (block, rate-limit per host/path/method)
- Web dashboard for secret and agent management
- Bitwarden fallback via Noise protocol (Agent Access SDK, first integrator)
- Self-hostable, Docker Compose or K8s
- ~200MB RAM (Rust gateway + Next.js dashboard)
- Requires PostgreSQL (possible reuse of CloudNativePG — ADR 0012)

**Wardgate** (115 stars, AGPL-3.0, rejected):
- Richer feature set: HTTP + SSH + IMAP + SMTP, "conclaves" (isolated execution), anomaly detection
- More advanced policy engine (presets, anomaly detection)
- **But**: AGPL-3.0 license — constraining, requires distributing source code of any service interacting with Wardgate
- **But**: smaller community (115 stars vs 1.3k)
- **But**: more complex to operate for our use case (we need HTTP/HTTPS, not SSH/IMAP/SMTP)

**HashiCorp Vault** (rejected):
- The enterprise standard for secret management — dynamic secrets, rotation, full audit
- Documented pattern for AI agents (inject via sidecar or init container)
- **But**: heavy to operate (~500MB+ RAM, complex HA, unsealing, token policies)
- **But**: does not do MITM proxy — it provides secrets to workloads, but workloads have them in memory. No isolation in the OneCLI sense
- **But**: overkill for a single-node homelab

**Infisical** (12.7k stars, MIT, rejected):
- Open-source secret manager with MCP server (Model Context Protocol)
- Nice interface, automatic rotation, audit
- **But**: same model as Vault — distributes secrets to workloads, no injection proxy
- **But**: requires PostgreSQL + Redis, high footprint

**Composio** (27.5k stars, rejected):
- 850+ managed OAuth connectors, richest in integrations
- **But**: SaaS — credentials are with them, not self-hostable
- **But**: total vendor lock-in

### Cluster Integration

```
Namespace: onecli
  Deployment: onecli (gateway :10255 + dashboard :10254)
  Service: onecli-gateway  (ClusterIP)
  Service: onecli-dashboard (ClusterIP)
  CloudNativePG Cluster: onecli-pg (or reuse of an existing cluster)
  Secret: onecli-ca (ca.key + ca.pem) -- generated at first start
  Secret: encryption-key -- vault encryption key
  ConfigMap: onecli-ca-cert (ca.pem distributed to pods)

Namespace: agents (or any other namespace)
  Pod: my-agent
    env:
      HTTPS_PROXY: http://x:aoc_xxx@onecli-gateway.onecli.svc:10255
      NODE_EXTRA_CA_CERTS: /etc/onecli/ca.pem
      SSL_CERT_FILE: /etc/onecli/combined-ca.pem
    volumeMount: /etc/onecli/ca.pem (from ConfigMap onecli-ca-cert)
```

A single gateway for the entire cluster, multi-tenant via agent token. The CA cert is distributed via ConfigMap to all pods that need the proxy.

### Identified Risks

- **Young project** (3 weeks old at evaluation time, single maintainer). Mitigated by: code is in Rust (memory safe), scope is limited (HTTP proxy), and the pattern is recommended by Anthropic
- **No network enforcement** — a workload can ignore `HTTPS_PROXY` and make direct requests. It won't have credentials, but can communicate freely. Mitigated by: K8s NetworkPolicies could force outbound traffic through the gateway if needed
- **MITM = trust point** — the gateway sees all intercepted workload requests in plaintext. This is by design, but it concentrates risk on one component
- **PostgreSQL required** — adds a CloudNativePG instance (ADR 0012). Acceptable since the operator is already deployed

## Consequences

- OneCLI is deployed by Flux as a HelmRelease or Kustomization (ADR 0001, ADR 0002)
- Infrastructure secrets (GitHub token, Anthropic key, etc.) are stored in the OneCLI vault, **not** in SOPS K8s Secrets for workloads that use the proxy
- SOPS + Age (ADR 0003) remains used for secrets that don't go through the proxy (application configs, S3 credentials for CloudNativePG, etc.)
- The OneCLI CA cert is distributed via ConfigMap — any pod that needs the proxy mounts this cert
- The PostgreSQL instance for OneCLI is a dedicated CloudNativePG cluster (ADR 0012), with the same backup strategy (daily full + WAL to S3, 3-day retention)
- If OneCLI is abandoned, migration means reverting to classic K8s Secrets or switching to Wardgate — workloads only need to change the `HTTPS_PROXY` variable
- Worth monitoring: the Bitwarden Agent Access SDK protocol could become a standard for agent credential injection. OneCLI is the first to implement it
