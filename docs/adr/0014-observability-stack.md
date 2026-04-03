# ADR 0014 — Observability Stack

## Status

Accepted

## Context

The cluster needs monitoring (system and application metrics), centralized logs, dashboards, and alerting. The current infrastructure uses Beszel for system monitoring — a simple but non-customizable tool, limited to node-level metrics, and unable to monitor K8s workloads.

The cluster is single-node on a VPS with limited resources (4-8GB RAM). Each observability component consumes RAM that is no longer available for workloads. The choice must balance completeness and footprint.

Three decision axes:
1. **Metrics** — collection, storage, alerting
2. **Logs** — collection, storage, search
3. **Dashboards** — visualization, metrics/logs correlation

Options evaluated: kube-prometheus-stack + Loki + Alloy (multi-chart), grafana/k8s-monitoring (unified chart), OpenObserve (alternative all-in-one), SigNoz (ClickHouse all-in-one).

## Decision

`grafana/k8s-monitoring` as a unified chart, deploying Prometheus, Loki, Grafana, and Alloy in a single HelmRelease.

## Rationale

### Why a Unified Chart Over Multi-Chart

The classic approach deploys `kube-prometheus-stack` (Prometheus + Grafana + Alertmanager + exporters) then `grafana/loki` and `grafana/alloy` separately. This creates an inconsistency: metrics are a monolith (everything in kube-prometheus-stack), logs are granular (Loki + Alloy separately). Grafana is trapped inside the metrics chart, complicating its configuration for log datasources.

`grafana/k8s-monitoring` solves this by being an **official unified Grafana Labs chart** that deploys the entire stack as sub-charts:

```
HelmRelease: k8s-monitoring
  ├── Alloy (DaemonSet)          ← unified collector for metrics + logs
  ├── Prometheus (sub-chart)     ← metrics storage + alerting
  ├── Loki (sub-chart)           ← log storage
  ├── Grafana (sub-chart)        ← dashboards with pre-wired datasources
  ├── node-exporter (DaemonSet)  ← system metrics
  ├── kube-state-metrics         ← K8s object metrics
  ├── pre-installed dashboards   ← cluster, nodes, pods, namespaces
  └── alerting rules             ← default alerts
```

One HelmRelease in the GitOps repo, one source of values, complete coherence between metrics and logs.

### Detailed Comparison

**grafana/k8s-monitoring** (chosen):
- Official Grafana Labs chart, actively maintained
- Deploys Prometheus + Loki + Grafana + Alloy + exporters as one coherent block
- Pre-wired Grafana datasources (Prometheus for metrics, Loki for logs)
- Pre-installed dashboards and alerting rules
- Alloy as unified collector replaces both Prometheus scraping and Promtail (one DaemonSet for both node metrics and logs)
- Originally designed for Grafana Cloud but supports local backends since v2.x
- Standard Prometheus ecosystem: PromQL, ServiceMonitor, PodMonitor, PrometheusRule — all community integrations work

**kube-prometheus-stack + Loki + Alloy** (rejected):
- The most widespread approach, extremely battle-tested
- kube-prometheus-stack alone has hundreds of pre-configured alerting rules and dashboards
- **But**: 3+ distinct HelmReleases to maintain, inconsistent patterns
- **But**: Grafana is bundled in kube-prometheus-stack — configuring it for Loki too requires navigating the values of an enormous chart (~50+ templates)
- **But**: Alloy and Promtail coexist poorly, must choose and manually configure wiring

**OpenObserve** (rejected):
- Single Rust binary: metrics + logs + traces in one process
- Storage on Parquet + S3 — minimal storage cost (S3 nearly free)
- Integrated UI, ~256MB RAM to start — the lightest by far
- **But**: partial PromQL — some complex queries don't work, community Grafana dashboards are not reusable
- **But**: no ServiceMonitor/PodMonitor CRDs — scrape targets must be configured manually or via OpenTelemetry
- **But**: young ecosystem (13k stars), less documentation, fewer integrations
- **But**: different philosophy (Parquet + S3 = optimized for storage cost and analytical queries, but higher latency on real-time queries). Prometheus TSDB with Gorilla compression (1-2 bytes/sample) is more efficient in pure compression for metrics, and queries on the in-RAM head block are in microseconds vs hundreds of ms on S3
- OpenObserve would be relevant if storage cost were a concern or if a minimal stack were wanted. Not the case here — we want standard and a showcase

**SigNoz** (rejected):
- All-in-one on ClickHouse: metrics + logs + traces, integrated UI, PromQL supported
- OpenTelemetry-native
- **But**: ~3-4GB RAM minimum (ClickHouse alone consumes ~2GB) — disproportionate for a 4-8GB VPS
- **But**: ClickHouse is an operationally heavy component for a homelab

### Metrics: Prometheus

Prometheus is the de facto standard for Kubernetes metrics. PromQL is the universal query language, ServiceMonitor/PodMonitor CRDs are supported by all operators (CloudNativePG, Traefik, Flux...), and nearly all community Grafana dashboards target Prometheus.

**VictoriaMetrics** was considered as an alternative (2x less RAM, drop-in compatible PromQL via MetricsQL). The compatibility is real (~99% of integrations work), but staying with Prometheus is motivated by:
- **Standardization** — this is a showcase project, we want recognizable standards
- **Guaranteed ecosystem** — zero risk of incompatibility with a ServiceMonitor or dashboard
- **Better for learning** — understanding Prometheus is understanding K8s observability

Prometheus RAM optimization is achieved through: 30s scrape interval (instead of 15s default), relabeling to drop unused metrics (kube-state-metrics and cAdvisor generate many), and GOGC=50 for more aggressive Go GC.

### Logs: Loki + Alloy

Loki is the "Prometheus of logs" — it only indexes labels (namespace, pod, container), not log content. Content is stored in compressed chunks and scanned at query time (distributed grep). This is what makes it lightweight compared to Elasticsearch/Splunk which index every word.

**Alloy** (formerly Grafana Agent) replaces Promtail as log collector. It is a DaemonSet that tails container log files on each node, adds K8s labels, and pushes to Loki. Alloy can also collect metrics (Prometheus scraper mode), unifying collection in a single agent.

The alternative "no logs" (`kubectl logs` only) was considered to save ~300-600MB RAM. But metrics/logs correlation in Grafana (see a latency spike → click → see corresponding logs) justifies the cost. Logs will be deployed from the start.

Loki in monolithic mode with strict memory limits (`512Mi`) to avoid unpredictable spikes on broad queries.

### Dashboards: Grafana

There is no viable alternative to Grafana for K8s visualization in 2026. The community dashboard ecosystem (K8s, CloudNativePG, Traefik, Flux, etc.) exclusively targets Grafana. At ~100-150MB RAM, it is reasonable.

Alternatives evaluated and rejected:
- **Perses** (CNCF): promising, dashboard-as-code, but immature — almost no pre-built dashboards
- **Netdata**: complete autonomous stack, does not connect to Prometheus/Loki. Not a viewer
- **vmui** (VictoriaMetrics): good for ad-hoc debugging, not for persistent dashboards

### Retention

**Metrics (Prometheus): 30 days.** The current infrastructure (Beszel) offered ~1 year of history at degraded resolution (1min → 10min → 1h → 1d). Switching to Prometheus with 30-day retention is a regression in temporal depth, but a major gain in granularity (30s for 30d vs Beszel which degrades after 1h) and capability (K8s metrics, application metrics, alerting).

To partially compensate for the depth loss, **recording rules** pre-aggregate key metrics (average CPU, RAM, disk, HTTP requests) into low-cardinality series (~20 series). These lightweight series (~1 MB for 30 days) allow visualizing trends within the retention window without scanning thousands of raw series.

**Logs (Loki): 7 days.** Logs rarely have value beyond a week on a homelab. Sufficient for investigating a recent incident.

**Expendable data.** Coherent with ADR 0005: metrics and logs are on local PVC, no backup to S3. If the node dies, history is lost but the cluster rebuilds in 15 minutes and metrics start accumulating again. There is no business value in this data.

**Estimated disk:**

| Signal | Retention | Estimated disk |
|---|---|---|
| Metrics (~40k series, 30s scrape) | 30 days | ~10-15 GB |
| Logs (~15 pods, moderate volume) | 7 days | ~1-3 GB |

### Long-term Storage — Evaluated and Rejected

The question of long-term metrics storage (beyond 30 days) was studied in detail. Two solutions exist in the Prometheus ecosystem:

**Thanos** (CNCF): sidecar architecture. A lightweight container (~100MB) is added to the Prometheus pod and uploads TSDB blocks to S3 every 2 hours. To query history, a Store Gateway (reads blocks from S3), a Query (unified PromQL entry point for local + S3), and a Compactor (downsampling: raw → 5min → 1h, purge) must also be deployed. Downsampling would allow keeping 1 year of recording rules at 1h resolution for almost nothing in S3 storage (~100-500 MB/year).

**Mimir** (Grafana Labs): remote_write architecture. Prometheus pushes metrics via HTTP to Mimir which stores them on S3. More integrated (single process in monolithic mode) but heavier (~512MB+ RAM) because it redo the ingestion work of Prometheus (RAM buffering, compaction).

**Why rejected**: the full Thanos stack (sidecar + compactor + store gateway + query) represents ~600-800MB of additional RAM — more than the k0s control plane itself (~300MB). This is an architecture designed for enterprises with millions of series and hundreds of Prometheus instances, disproportionate for 20 recording rules on a homelab. Monolithic Mimir is slightly lighter but still ~512MB+.

The actual need (seeing CPU/RAM/disk trends over a few months) does not justify doubling the observability stack's memory footprint. 30 days of recording rules at 5-minute granularity cover short/medium-term trend detection. If the need for annual trends concretely manifests, Thanos can be added — the sidecar is native in kube-prometheus-stack (sub-chart of k8s-monitoring) and blocks would be archived to the same S3 bucket as CloudNativePG backups (ADR 0012).

### Total RAM Estimate

| Component | Estimated RAM |
|---|---|
| Prometheus | 600MB - 1GB (optimized: 30s scrape, GOGC=50, relabeling) |
| Alertmanager | 20-40MB |
| Loki (monolithic, limited) | 300-512MB |
| Alloy (DaemonSet) | 50-80MB |
| node-exporter | 15-30MB |
| kube-state-metrics | 30-80MB |
| Grafana | 100-150MB |
| **Total** | **~1.1 - 1.9GB** |

On an 8GB VPS, that is 15-25% of RAM for observability — acceptable. On 4GB, it is tight but viable with Prometheus optimizations.

## Consequences

- Beszel is removed — replaced by Grafana + Prometheus for system and application monitoring
- The `grafana/k8s-monitoring` chart is deployed by Flux as a single HelmRelease (ADR 0001, ADR 0002)
- Metrics are stored locally by Prometheus (local PVC, 30-day retention, considered expendable — ADR 0005)
- Logs are stored locally by Loki (local PVC, 7-day retention, considered expendable — ADR 0005)
- Recording rules pre-aggregate key metrics (~20 series) for trends within the 30-day window
- Each application that exposes metrics (Traefik, CloudNativePG, Flux, OneCLI) declares a ServiceMonitor or PodMonitor in the GitOps repo
- CloudNativePG backup monitoring (ADR 0012) connects to Prometheus via the operator's native metrics + alerting rules for backup failures
- Custom dashboards are provisioned via ConfigMaps in the GitOps repo (versioned, declarative)
- If RAM becomes an issue, VictoriaMetrics remains a drop-in migration option without changing dashboards or ServiceMonitors
- If the need for trends beyond 30 days manifests, Thanos sidecar can be enabled in the kube-prometheus-stack values (sub-chart) with no architecture change
