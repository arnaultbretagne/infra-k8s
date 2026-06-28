# ADR 0006 — CNI Selection

## Status

Accepted (April 2026) — **Cilium**. Supersedes the original Flannel decision (February 2026, kept below for context). With kube-proxy replacement enabled, Cilium also provides LoadBalancer IPAM + L2 announcement, which supersedes MetalLB (ADR 0007).

## Original Decision (February 2026): Flannel

k0s (ADR 0001) does not provide a CNI by default. One must be chosen to ensure network communication between pods.

Options evaluated: Flannel, Calico, Cilium. The primary criterion was simplicity — the cluster was single-node on a VPS with assumed limited resources (4-8GB RAM), in a DevOps learning context.

**Flannel was chosen** for its minimal footprint (~50MB), zero configuration, and simplicity. Network policies were considered unnecessary on a single-node setup without multi-tenancy. The ADR documented a migration path to Cilium if requirements changed.

### Original comparison

| Criteria | Flannel | Calico | Cilium |
|---|---|---|---|
| Network model | Overlay VXLAN | Native BGP or VXLAN | eBPF (kernel-level) |
| Network policies | **No** | Yes (iptables) | Yes (eBPF, L3-L7) |
| Network observability | No | Basic | **Hubble** (L7, service map) |
| Replaces kube-proxy | No | No | **Yes** (saves ~50MB) |
| Integrated LB | No | No | **Yes** (makes MetalLB optional) |
| Idle RAM | **~50MB** | ~100-150MB | ~200-300MB |
| Configuration | Zero config | Moderate | Complex |
| Operational complexity | Minimal | Moderate | High (eBPF, kernel compat) |

The original rejection reasons for Cilium were: RAM overhead disproportionate on 4-8GB, operational complexity, steep learning curve.

---

## Re-evaluation (April 2026): Switch to Cilium

### What changed

Three factors invalidated the original assumptions:

1. **The VPS has 16GB RAM, not 4-8GB.** The ~200-300MB overhead of Cilium is 1.5-2% of available memory, not the 5-7% originally estimated. The resource constraint that drove the Flannel decision does not exist.

2. **The cluster hosts an identity provider (Pocket-ID, ADR 0009).** An IdP is a high-value target — it issues OIDC tokens that control access to all other services. Without network policies, any compromised pod can reach Pocket-ID and its PostgreSQL database on any port. Container-level hardening (securityContext, PSS) limits what an attacker can do *inside* a pod, but does not restrict *which pods can talk to each other*.

3. **Preview-in-prod (ADR 0017) will run unmerged code in the production cluster.** ResourceSet-created preview pods will execute code from open PRs — code that has not been reviewed or merged. Without network segmentation, a preview pod has unrestricted network access to production services, including the IdP and its database.

Additionally, more applications are planned (AIOStream and others), each with their own CNPG cluster. The blast radius of a compromised pod grows with each new namespace.

### Why now

The cluster has not been deployed yet. Switching CNI on a running cluster requires draining nodes, reinstalling the CNI, and restarting all pods. On a fresh bootstrap, it costs nothing — just a different Helm chart in the manifests.

## Decision

Cilium, deployed as a HelmRelease via Flux, with Hubble disabled initially.

## Rationale

### Why Cilium over Calico

Both provide Kubernetes-standard NetworkPolicies. The differentiators:

| | Calico | Cilium |
|---|---|---|
| **Implementation** | iptables rules | eBPF programs |
| **L7 policies** | No (L3/L4 only) | Yes (HTTP path, headers, DNS FQDN) |
| **kube-proxy replacement** | No | Yes (cleaner, fewer iptables chains) |
| **Observability** | iptables logs | Hubble (flow logs, service map, DNS visibility) |
| **CiliumNetworkPolicy** | N/A | Extends K8s NetworkPolicy with L7, FQDN egress, DNS filtering |
| **CNCF status** | Not CNCF | Graduated |
| **Ecosystem momentum** | Stable, mature | Growing, becoming default for new clusters |

Calico would solve the NetworkPolicy problem, but Cilium also provides the observability foundation needed for the monitoring stack (ADR 0014) and the L7 filtering that strengthens preview-in-prod isolation.

### Deployment mode

- **Hubble**: disabled at first. Enables flow visibility but adds ~100-150MB RAM. Will be enabled when the observability stack (ADR 0014) is deployed, so Grafana can consume Hubble metrics.
- **kube-proxy replacement**: enabled. Removes the need for kube-proxy iptables rules. k0s supports this via `network.kubeProxy.disabled: true` in k0s.yaml.
- **Load balancing**: handled by Cilium natively — **no MetalLB**. With kube-proxy replacement enabled, Cilium provides LoadBalancer IPAM (`CiliumLoadBalancerIPPool`) + L2 announcement (`CiliumL2AnnouncementPolicy`), assigning the VPS public IP to the Traefik LoadBalancer Service. One whole component removed (MetalLB, ADR 0007 superseded) — fewer moving parts to operate, consistent with the agent-operated model.

### Example NetworkPolicy unlocked

```yaml
# Pocket-ID can only reach its own PostgreSQL + DNS
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: pocket-id-egress
  namespace: pocket-id
spec:
  podSelector:
    matchLabels:
      app: pocket-id
  policyTypes: [Egress]
  egress:
    - to:
        - podSelector:
            matchLabels:
              cnpg.io/cluster: pocket-id-pg
      ports:
        - port: 5432
    - to:
        - namespaceSelector: {}
      ports:
        - port: 53
          protocol: UDP
```

With Flannel, this manifest is accepted by the API server but **silently ignored**. With Cilium, it is enforced.

## Consequences

- Cilium is deployed by Flux as a HelmRelease, coherent with the GitOps approach (ADR 0002)
- NetworkPolicies can now be defined per-app to restrict pod-to-pod traffic
- NetworkPolicies are **load-bearing, not optional**: they are the control that makes preview-in-prod (ADR 0017) safe on a single node and that isolates the IdP (Pocket-ID). Flannel accepted them but silently ignored them — this is what makes Cilium **required**, not a preference
- kube-proxy is disabled in k0s.yaml — Cilium handles Service load-balancing via eBPF
- MetalLB (ADR 0007) is **removed** — Cilium assigns external LoadBalancer IPs via LB-IPAM + L2 announcement (`CiliumLoadBalancerIPPool` + `CiliumL2AnnouncementPolicy`)
- Hubble is initially disabled; will be enabled alongside the observability stack (ADR 0014)
- The Flannel namespace (`kube-flannel`) and its PSS label (`privileged`) are removed
- Cilium runs in `kube-system` with PSS `privileged` (required for eBPF and host networking)
- The bootstrap script installs Cilium via Helm before Flux — breaking the chicken-and-egg (Flux needs running pods → pods need a CNI); Flux's helm-controller adopts the release afterward
