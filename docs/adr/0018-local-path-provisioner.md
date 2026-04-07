# ADR 0018 — Local-Path-Provisioner as Storage Class

## Status

Accepted

## Context

k0s with `storage.type: kine` (SQLite backend) does not provision a default StorageClass. Workloads that need persistent volumes (CNPG PostgreSQL clusters, ACME cert storage) require one.

The cluster is single-node (ADR 0001) — distributed storage is unnecessary.

## Decision

Rancher's local-path-provisioner, deployed by Flux as a HelmRelease from the upstream GitRepository.

## Rationale

**local-path-provisioner** (chosen):
- Creates PersistentVolumes backed by host directories (`/opt/local-path-provisioner`)
- Zero overhead — no daemon, no network storage, just a lightweight controller (~30MB)
- `WaitForFirstConsumer` binding — volumes are created on the node where the pod is scheduled
- `Delete` reclaim policy — PV is cleaned up when the PVC is deleted
- Widely used default in k3s and lightweight clusters

**OpenEBS LocalPV** (rejected):
- More features (LVM, ZFS backends) but unnecessary complexity for hostPath volumes
- Heavier operator footprint

**k0s built-in storage** (rejected):
- k0s can embed local-path-provisioner via `spec.extensions.storage`, but this conflicts with the GitOps principle of managing all components via Flux (ADR 0002). Using the built-in would create a component invisible to the Git repo.

**No StorageClass / emptyDir only** (rejected):
- CNPG requires PVCs for PostgreSQL data. emptyDir is ephemeral and lost on pod restart — incompatible with database persistence.

## Consequences

- `local-path` is the only StorageClass in the cluster (not marked as default — PVCs must reference it explicitly)
- Data lives on the host filesystem at `/opt/local-path-provisioner` — included in the stateless/S3-first strategy (ADR 0005) where local PVCs are reconstructible from S3 backups
- No volume snapshots, no dynamic resize — acceptable for small infrastructure databases
- If the cluster moves to multi-node, a distributed storage solution (Longhorn, Rook-Ceph) would replace this
