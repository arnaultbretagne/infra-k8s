# ADR 0003 — SOPS + Age for Secret Management

## Status

Accepted

## Context

Secrets (DB passwords, API keys, S3 credentials for CloudNativePG WAL — ADR 0005) must be versioned in Git without being readable in plaintext. The chosen tool must integrate with Flux (ADR 0002) so that secrets are automatically deployed as Kubernetes Secrets.

Options evaluated: Sealed Secrets (Bitnami), SOPS + Age, External Secrets Operator (ESO).

Note: this ADR covers encryption of secrets **in Git** (supply chain). Encryption of secrets **in the K8s datastore** (runtime) is covered by ADR 0011.

## Decision

SOPS + Age.

## Rationale

### Detailed Comparison

Three solutions were evaluated on the following criteria: encryption model, portability, Flux integration, operational complexity, and impact on PR reviews.

**SOPS + Age** (chosen):
- **Selective encryption**: SOPS encrypts only the values, keeping YAML keys readable. A Git diff shows "the `password` field changed" — PR reviews remain useful and informative
- **Portable**: the Age key is a simple file, independent of the cluster. If the cluster is destroyed, secrets can still be decrypted with the Age key from any machine. Reconstruction from scratch (ADR 0005) does not depend on an in-cluster controller
- **Native Flux integration**: Flux supports SOPS natively (no plugin, no additional controller). The Age key is injected as a Secret at bootstrap, Flux decrypts automatically
- **Simple**: one `sops` binary, one `age` key. No additional component in the cluster. The Age key is generated in one command (`age-keygen`)
- **Flexible**: `.sops.yaml` at the repo root defines encryption rules per path (e.g., `secrets/**/*.yaml` encrypts with the prod key, `secrets/dev/**` with the dev key)

**Sealed Secrets (Bitnami)** (rejected):
- An in-cluster controller generates a key pair. Secrets are encrypted locally with `kubeseal`, the controller decrypts them in the cluster
- **But**: encrypts the **entire YAML** into an opaque blob (`SealedSecret`). A Git diff shows "a blob changed" — no visibility on which field was modified. PR reviews on secrets are impossible
- **But**: the encryption key is **tied to the cluster**. If the cluster is destroyed, SealedSecrets in Git are unreadable. The controller's private key must have been backed up — one oversight and all secrets are lost
- **But**: requires an active in-cluster controller to decrypt. Adds a component to maintain and a failure point
- Advantage: the developer workflow is simple (`kubeseal < secret.yaml > sealed.yaml`). But this advantage does not compensate for the limitations in a GitOps setup where PRs are the primary workflow

**External Secrets Operator (ESO)** (rejected):
- Synchronizes secrets from an external vault (AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager...) into Kubernetes Secrets
- **But**: requires an external vault — adds a critical infrastructure component outside the cluster, with its own cost, management, and network dependency
- **But**: the source of truth is no longer Git but the vault — breaks the GitOps principle where Git is the sole source of truth
- **But**: overkill for a solo/homelab setup. ESO makes sense in enterprise with a centralized vault shared between teams
- Advantage: automatic secret rotation, centralized multi-cluster management. Not relevant for single-node

### What SOPS Does Not Protect

SOPS encrypts secrets in Git (at-rest in the repo). After decryption by Flux, secrets are stored in plaintext in the K8s datastore (SQLite/Kine). ADR 0011 (EncryptionConfiguration) covers this second layer. The two are complementary:

| Layer | Protected by | Threat model |
|---|---|---|
| Secrets in Git | SOPS + Age (this ADR) | Repo leak, unauthorized code access |
| Secrets in K8s datastore | EncryptionConfiguration (ADR 0011) | Node filesystem access, backup, VM snapshot |

## Consequences

- The Age private key must be stored outside the repo and the cluster (secure backup). It is one of two secrets to manually inject at bootstrap (the other being the AES key for EncryptionConfiguration — ADR 0011)
- `.sops.yaml` at the repo root defines encryption rules (which files, with which key)
- To add a secret: create the plaintext YAML, `sops --encrypt`, commit the encrypted file
- If the Age key is lost, SOPS files in Git are unreadable — all secrets must be re-generated. Backing up the Age key is critical
- S3 credentials for CloudNativePG (ADR 0005), Pocket-ID secrets (ADR 0009), and all other application secrets follow this same workflow
