# ADR 0011 — Kubernetes Secrets Encryption at Rest

## Status

Accepted

## Context

Kubernetes Secrets (tokens, passwords, API keys) follow this path:

```
Git (encrypted SOPS+Age, ADR 0003) → Flux decrypts → K8s Secret (plaintext in datastore) → Pod
```

SOPS+Age protects the Git supply chain. But after decryption by Flux, secrets are stored **in plaintext** in the k0s datastore.

k0s in single-node mode (ADR 0001) uses **SQLite via Kine** as its datastore — not etcd. The SQLite file (`/var/lib/k0s/db/state.db`) contains all secrets in plaintext. Anyone who accesses this file (copy, backup, VM snapshot) can read the secrets.

### Why Not PostgreSQL as k0s Datastore?

k0s supports PostgreSQL via Kine, but PostgreSQL cannot run **inside** the cluster it serves as datastore — circular dependency (k0s needs the datastore to start → PG needs the cluster to be scheduled → infinite loop). An external PG would be needed, adding complexity with no benefit on single-node where SQLite is sufficient.

Application PostgreSQL (CloudNativePG, ADR 0005) is a separate concern: it runs inside the cluster, managed by Flux, and stores business data — not K8s state.

### Why Not LUKS?

Full-disk encryption (LUKS/dm-crypt) depends on the VPS provider and adds an operational layer (decryption key management at boot, impact on snapshots). EncryptionConfiguration is more targeted: it only encrypts K8s Secrets, at the application level, with no provider dependency.

## Decision

Enable Kubernetes EncryptionConfiguration at k0s bootstrap. AES-CBC encryption of Secrets in the SQLite/Kine datastore.

## Rationale

- **Defense in depth**: SOPS protects Git (supply chain), EncryptionConfiguration protects the datastore (runtime). Two distinct threat models, two complementary layers
- **Kubernetes standard**: native kube-apiserver mechanism, not an addon
- **Transparent**: the API server encrypts/decrypts automatically. kubectl, Flux, pods see no difference
- **Targeted**: only Secrets are encrypted (not ConfigMaps, not Pods) — good security/performance ratio
- **SQLite/Kine compatible**: works the same way as with etcd, encryption happens before writing to the datastore regardless

## Implementation

This is a **bootstrap responsibility, not GitOps**. Flux cannot manage this config because:
- The `EncryptionConfiguration` file lives on the host filesystem
- It is referenced in `k0s.yaml` via an API server `extraArgs`
- k0s must be restarted to apply the change
- Flux runs inside the cluster and has no host access

### Responsibility Boundaries

| Layer | Managed by |
|---|---|
| k0s.yaml + EncryptionConfiguration + encryption key | **Bootstrap** (k0sctl, Ansible, cloud-init, or manual) |
| Age key for Flux (SOPS) | **Bootstrap** (injected as Secret at Flux bootstrap) |
| All application secrets (SOPS in Git) | **Flux / GitOps** |
| S3 credentials for CloudNativePG WAL | **Flux / GitOps** (SOPS Secret decrypted by Flux, read by CNPG) |

### k0s Config

```yaml
# k0s.yaml
spec:
  api:
    extraArgs:
      encryption-provider-config: /var/lib/k0s/pki/encryptionconfig.yaml
```

```yaml
# /var/lib/k0s/pki/encryptionconfig.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
    providers:
      - aescbc:
          keys:
            - name: key1
              secret: <base64-encoded-32-byte-key>
      - identity: {}   # fallback for reading not-yet-encrypted secrets
```

After activation, re-encrypt existing secrets:
```bash
kubectl get secrets --all-namespaces -o json | kubectl replace -f -
```

## Consequences

- The AES encryption key must be backed up outside the cluster (same secure backup as the Age key — ADR 0003)
- If the key is lost and the cluster destroyed, secrets in a potential SQLite backup are unreadable — but they are reconstructible from Git (SOPS+Age) so this is not blocking
- Cluster bootstrap now involves two secrets to manually inject: the Age key (for Flux/SOPS) and the AES key (for EncryptionConfiguration)
- k0s Autopilot does not manage k0s.yaml — encryption config updates (key rotation) are a manual operation or via k0sctl
- ConfigMaps are not encrypted — do not store sensitive data in them (use Secrets)
