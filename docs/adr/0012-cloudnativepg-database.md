# ADR 0012 — CloudNativePG as Database Operator

## Status

Accepted

## Context

Certain cluster applications require a PostgreSQL database (Dagster metadata, future application data). The general strategy is stateless/S3-first (ADR 0005), but relational databases remain necessary for transactional data.

The cluster is single-node on a VPS (ADR 0001). The objective is reconstruction from scratch in under 15 minutes, which requires a robust backup strategy to external storage (S3).

Note: this application PostgreSQL is distinct from the k0s datastore which uses SQLite/Kine (ADR 0011). Application PostgreSQL runs inside the cluster as a workload managed by Flux, not externally.

Options evaluated for the operator: CloudNativePG (EDB), Crunchy PGO (Crunchy Data), Zalando postgres-operator.

## Decision

CloudNativePG with Barman Cloud for backup, daily full + continuous WAL archiving to S3, 3-day retention with daily restore test.

## Rationale

### Operator Choice

**CloudNativePG** (chosen):
- Kubernetes-native operator: the PostgreSQL cluster is declared in YAML (CRD `Cluster`), coherent with the GitOps approach (ADR 0002)
- No dependency on Patroni or etcd for HA — the operator manages primary election via Kubernetes primitives
- Natively handles: provisioning, streaming replication, automatic failover, switchover, rolling updates, automatic TLS, PgBouncer sidecar, Prometheus monitoring
- Integrated backup via Barman Cloud (default) or pgBackRest, to S3/MinIO/GCS/Azure
- CNCF project (sandbox), wide adoption, good documentation
- Lightweight: the operator itself consumes ~100MB RAM

**Crunchy PGO** (rejected):
- Mature operator, maintained by Crunchy Data
- Uses pgBackRest natively (richer than Barman for large volumes)
- **But**: more complex architecture (more components, more CRDs), less accessible documentation
- **But**: overkill for small infrastructure databases on single-node

**Zalando postgres-operator** (rejected):
- Used by Zalando in production at large scale
- Patroni for HA (additional component)
- **But**: more oriented toward multi-team/platform, with self-service provisioning features
- **But**: disproportionate complexity for the use case

### Backup Backend Choice: Barman Cloud

For small-volume infrastructure databases (a few dozen MB), Barman Cloud (the CloudNativePG default) is the right choice:
- Native integration, zero additional configuration
- Full backup via `pg_basebackup`, WAL archiving via `barman-cloud-wal-archive`
- Compression (snappy, gzip, zstd) and push to S3
- Automatic retention management (purges old backups and orphaned WAL)

pgBackRest would be relevant for larger databases with specific needs (incremental/differential backup, delta restore, backup from standby, advanced verify). Not necessary at this stage.

### Backup Strategy: Daily Full + WAL Archiving

Two forms of incremental coexist in PostgreSQL and the difference must be understood to choose well:

**WAL archiving**: records every physical modification (page-level) sequentially. If a row is modified 1000 times in a day, the WAL contains 1000 entries. It is an exhaustive journal of all operations — no deduplication. The archive_timeout (5 minutes by default in CloudNativePG) forces archiving of the current WAL segment even if it is not full, giving a maximum RPO of 5 minutes.

**Incremental backup** (PostgreSQL 17+): captures a snapshot of modified pages since the previous backup. If a page has been modified 1000 times, the incremental stores only the final state — once, 8 KB. It is more storage-efficient when WAL volume is disproportionate relative to actually modified pages (write-heavy workloads with repetitive updates on the same rows).

**For small infrastructure databases** (PocketID, Dagster), daily WAL volume is on the same order of magnitude as the database size. Incremental adds almost nothing compared to WAL alone. Daily full + continuous WAL archiving is the simplest and most efficient pattern:

- Daily full: free in time and I/O given the volumes (a few seconds for a few dozen MB)
- Continuous WAL archiving: 5-minute RPO, negligible storage cost
- No incremental: avoids the dependency chain complexity (full → incr1 → incr2 → ...) with no real gain

Incremental would become relevant if a larger application database with sustained write workload were added to the cluster. In that case, the decision would be re-evaluated.

### Retention: 3 Days with Daily Restore Test

Long retention (14d, 30d) is justified when fearing silent logical corruption (application bug that corrupts data without detection for days). For infrastructure databases:

- PocketID: if data is corrupted, users reconnect, sessions are recreated
- Dagster: run metadata is useful but not critical, clean redeploy possible

With a **daily restore test** (CronJob that restores the latest backup in an ephemeral pod and validates the database starts), you know within 24h if the backup is healthy. If the backup is guaranteed restorable, keeping 2-3 days is sufficient:

- Day D: today's full + current WAL
- Day D-1: yesterday's full (safety net)
- Day D-2: additional margin
- Beyond: automatic purge by Barman Cloud (backups + orphaned WAL)

The restore test is critical: an untested backup is not a backup. The test validates the entire end-to-end chain (the full is readable, WAL replays, the database starts and responds to queries).

### One PostgreSQL Cluster Per Application

Pattern recommended by CloudNativePG: isolate each application in its own PostgreSQL cluster rather than a shared PostgreSQL with multiple databases.

- **Blast radius**: a problem on the Dagster DB does not affect others
- **Independent lifecycle**: backup, retention, scaling, PG version can differ per app
- **In YAML**: it is just a duplicated manifest with a different name and S3 path

### S3 Credentials

S3 access credentials for WAL archiving and base backups are managed by SOPS + Age (ADR 0003):

```
Git (SOPS-encrypted) → Flux decrypts → K8s Secret "cnpg-s3-creds" → CloudNativePG reads the Secret
```

## Implementation

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: dagster-pg
  namespace: dagster
spec:
  instances: 1                     # single-node, no replica
  storage:
    size: 5Gi
  backup:
    barmanObjectStore:
      destinationPath: s3://pg-backups/dagster
      endpointURL: https://s3.example.com
      s3Credentials:
        accessKeyId:
          name: cnpg-s3-creds
          key: ACCESS_KEY_ID
        secretAccessKey:
          name: cnpg-s3-creds
          key: SECRET_ACCESS_KEY
      wal:
        compression: snappy
    retentionPolicy: "3d"

---
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: dagster-pg-daily
  namespace: dagster
spec:
  schedule: "0 3 * * *"
  cluster:
    name: dagster-pg
  backupOwnerReference: self
```

The daily restore test would be a CronJob that:
1. Restores the latest backup in an ephemeral pod
2. Verifies PostgreSQL starts (`pg_isready`)
3. Executes a few health queries
4. Reports the result as a metric / alert on failure
5. Destroys the pod

## Consequences

- CloudNativePG is deployed by Flux as a HelmRelease (ADR 0001, ADR 0002)
- Each application that needs PostgreSQL declares its own `Cluster` CRD in the GitOps repo
- S3 credentials are SOPS Secrets in the repo (ADR 0003), decrypted by Flux
- `instances: 1` on single-node — no HA replica. Resilience relies on WAL archiving + restore from S3. If scaling to multi-node, `instances: 2` with anti-affinity can be used
- Pocket-ID stays on embedded SQLite (no need for PostgreSQL for now). If its needs evolve, a dedicated CloudNativePG cluster would be created
- 3-day retention is calibrated for non-critical infrastructure databases. For irreplaceable business data (if they ever arrive), retention should be re-evaluated (30d+) and restore testing strengthened
- Backup monitoring (Backup CRD status, failure alerts) must be connected to the monitoring stack when available
