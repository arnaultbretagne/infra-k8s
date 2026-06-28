# ADR 0005 — Stateless / S3-First Approach

## Status

Accepted

## Context

State management strategy on a single-node cluster. Objective: reconstruct the **stateless core** from scratch in under 15 minutes, and keep persistent state small, explicit, and backed up.

## Decision

**Stateless by default.** Apps that can be stateless are — they write files/media to S3 and use CloudNativePG (WAL → S3) for relational data. Apps that are genuinely stateful are handled as **explicit, named exceptions** (see below), each with its own persistence + backup story. The goal is to keep "stateless by default" a real default, not let it drift into "stateful everywhere by accident."

## Rationale

- Stateless node = trivial reconstruction from Git + S3
- No need for Longhorn or distributed storage on single-node (saves ~300MB RAM)
- local-path-provisioner (ADR 0018) is sufficient for the few PVCs needed (DBs, caches, Prometheus, stateful exceptions)
- CloudNativePG provides PITR via WAL archives on S3 — RPO of minutes vs hours with periodic pg_dump
- Apps that *can* write to S3 via SDK should, rather than through PVCs

## Stateful Exceptions — Named, Not Silent

Some apps being migrated are genuinely stateful and not S3-native. Forcing them into the stateless mold costs more than accepting a managed exception. The rule: **every stateful app is listed here, with its persistence and backup**. Adding a new one means adding a row — a deliberate choice, reviewed in the PR.

| App | Why it is an exception | Persistence + backup |
|---|---|---|
| **code-server** | Persistent dev home + installed tooling/binaries — a durable workspace *is* the product | `local-path` PVC + scheduled backup to S3 (e.g. volsync/restic) |
| **obsidian-livesync** | Live-sync database of vault state, not object storage | `local-path` PVC + scheduled backup to S3 |

Anything not in this table is expected to be stateless or DB-backed (CloudNativePG, ADR 0012).

## Consequences

- Stateless apps write to S3 (no local filesystem); stateful apps are the named exceptions above, on `local-path` PVCs (ADR 0018)
- An S3-compatible bucket is required (Cloudflare R2, Scaleway Object Storage, Backblaze B2, etc.)
- Redis-type caches are reconstructible (local PVC, no backup)
- Prometheus metrics / Loki logs are expendable (local PVC, no backup — ADR 0014)
- CloudNativePG is installed when a DB is first needed (not at initial bootstrap)
- The "<15 min rebuild" promise holds for the **stateless core**; stateful exceptions restore from their S3 backups (slower, but bounded and explicit)
- K8s resources themselves are reconstructed from Git by Flux — no separate Velero dependency at this stage
