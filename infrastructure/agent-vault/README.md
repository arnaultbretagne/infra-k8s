# Agent Vault

Standalone [Infisical Agent Vault](https://github.com/Infisical/agent-vault/tree/v0.39.3),
not the Infisical platform or its Agent Proxy. Independently reconciled by Flux as
`agent-vault`. Version 0.39.3, multi-architecture image pinned by digest.

## Access and first start

The management UI/API is published at **https://agent-vault.bretagne.dev** behind an
oauth2-proxy gate (Pocket-ID client `agent-vault`, `ALLOWED_GROUPS=admin` — ADR 0021/0022,
same pattern as OneCLI's dashboard). Upstream's own guidance for operator access is
"keep private, or front with TLS + auth (SSO reverse proxy)"; this is the latter. The
MITM proxy port (14322) is **not** published: it is in-cluster only, for agent runtimes.
No application namespace has access yet. This protects first-owner registration.

```sh
kubectl -n agent-vault rollout status deployment/agent-vault deployment/oauth2-proxy
```

Open `https://agent-vault.bretagne.dev`, sign in with Pocket-ID (admin group), create
the owner account, then configure the vaults, credentials and agent permissions. The
owner password is separate from the server's encryption password, and both are separate
from the Pocket-ID login. Keep registration invite-only before adding consumers.
No credentials from OneCLI are copied and the existing service remains operational.

`AGENT_VAULT_ADDR` is set to the public URL: invite links, discovery responses and the
MITM certificate SANs derive from it (unset, upstream falls back to the bind address).

| Interface | Endpoint |
| --- | --- |
| Management API / UI (operators) | `https://agent-vault.bretagne.dev` (OIDC gate) |
| Management API (in-cluster) | `http://agent-vault-api.agent-vault.svc.cluster.local:14321` |
| Forward proxy (in-cluster only) | `http://agent-vault-proxy.agent-vault.svc.cluster.local:14322` |
| Proxy CA | API path `/v1/mitm/ca.pem` |

Before connecting Agora/runtimes, add explicit consumer network rules on both
sides, issue scoped **proxy-role** sessions and distribute the CA through the
trusted provisioning path. Some client operations need the authenticated API as
well as the proxy. Never give runtimes an owner session. Proxy/session lifecycle,
credential selection and provider policies belong to Agent Vault, not Agora.
Only public HTTPS upstreams are reachable; private ranges are disabled in the
application and cluster/host egress is not allowed by the proxy's network policy.
Internal HTTP transport assumes the cluster network is trusted; the in-cluster
services are plain HTTP and only the OIDC-gated HTTPS route above is public.

## Persistence and recovery

CNPG owns `agent-vault-pg` (PostgreSQL 17, 1 GiB local-path). Credentials, accounts,
sessions, the wrapped encryption key and the proxy CA live in PostgreSQL.
`/data` and `/tmp` are disposable; there is no application PVC.

The independent ResourceSet copies the existing S3 credentials. WAL archiving and
a daily 03:45 UTC backup use `s3://bretagne-pg-backups/agent-vault`, with three days'
retention. The daily 05:15 UTC restore job restores into an isolated temporary
PostgreSQL and requires the encrypted master key and CA records to exist. It does
not mount the master password or prove decryption; the local pre-deployment test
covered decryption and CA continuity after a logical dump/restore.

**Restore requires both the database backup and the original
`agent-vault-master` Secret.** Its password is encrypted in `master.secrets.yaml`;
the platform Age private key must be recoverable. Do not regenerate this Secret
when recreating the database, or change it as an ordinary password rotation.

For disaster recovery, replace `bootstrap.initdb` with CNPG `bootstrap.recovery`
and an `externalClusters` entry pointing to the existing bucket prefix/server
`agent-vault-pg`, before creating a replacement Cluster. Follow the platform CNPG
recovery procedure; `initdb` deliberately creates a **fresh** installation, it
does not automatically restore an old backup. Retain the old archive and use a
fresh backup server name/prefix for the recovered installation's outgoing archive.

## Operations

```sh
flux get kustomization agent-vault
kubectl -n agent-vault get clusters,backups,scheduledbackups,pods
kubectl -n flux-system get resourceset agent-vault-s3-creds
kubectl -n agent-vault create job --from=cronjob/agent-vault-pg-restore-test agent-vault-restore-check
kubectl -n agent-vault logs job/agent-vault-restore-check
kubectl -n agent-vault delete job agent-vault-restore-check
```

Readiness checks both the database-backed API health and the proxy listener;
upstream can serve the API even when CA/proxy initialization failed. Liveness
checks the API listener so a database outage does not cause a restart storm.
There is one replica and updates use Recreate: brief downtime is expected.

The namespace enforces baseline PSA because CNPG needs a root ownership init
container with local-path storage (hosting guide §12). Audit/warn are restricted;
Agent Vault itself runs non-root, with a read-only filesystem and no Kubernetes
token. TODO: enforce restricted when the storage ownership workaround is removed.

Initial provisioning is not acceptance: verify owner bootstrap, a scoped proxy
request, CNPG archiving and the real S3 restore job on the cluster. Do not remove
OneCLI until its consumers and required credentials have been migrated explicitly.
