# ADR 0005 — Stateless / S3-First Approach

## Status

Accepted

## Context

State management strategy on a disposable single-node cluster. Objective: be able to reconstruct the cluster from scratch in under 15 minutes.

## Decision

Minimize state on the node. Apps are stateless and connect to S3 for file storage. Databases use CloudNativePG with WAL archiving to S3.

## Rationale

- Disposable node = trivial reconstruction from Git + S3
- No need for Longhorn or distributed storage on single-node (saves ~300MB RAM)
- local-path-provisioner (deployed by Flux) is sufficient for the few PVCs needed (DB, Redis, Prometheus)
- CloudNativePG provides PITR (Point-in-Time Recovery) via WAL archives on S3 — max loss of a few seconds vs hours with periodic pg_dump
- Apps should ideally write files/media directly to S3 via SDK, not through PVCs

## Consequences

- Apps must be designed to write to S3 (no local filesystem)
- An S3-compatible bucket is required (Scaleway Object Storage, Backblaze B2, etc.)
- Redis is treated as a reconstructible cache (local PVC, no backup)
- Prometheus metrics are considered expendable (local PVC, no backup)
- CloudNativePG will be installed when a DB is needed (not at initial bootstrap)
- Velero covers backup of K8s resources themselves
