# ADR 0006 — Flannel as CNI

## Status

Accepted

## Context

k0s (ADR 0001) does not provide a CNI by default. One must be chosen to ensure network communication between pods.

Options evaluated: Flannel, Calico, Cilium. The primary criterion is simplicity — the cluster is single-node on a VPS with limited resources (4-8GB RAM), in a DevOps learning context.

## Decision

Flannel.

## Rationale

### Detailed Comparison

Three CNIs were evaluated on the following criteria: simplicity, memory footprint, network policies, network observability, and ability to replace kube-proxy.

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

**Flannel** (chosen):
- The simplest: does one thing (overlay network between pods), does it well, and requires zero configuration
- Low memory footprint (~50MB) — important on a resource-limited VPS
- Sufficient for single-node: pod-to-pod networking is local, no complex inter-node routing
- Deployed by Flux as a DaemonSet, coherent with the GitOps approach (ADR 0001, ADR 0002)

**Calico** (rejected):
- Provides iptables-based network policies — controls which app can talk to which
- Heavier (~100-150MB) and more complex to configure (BGP peering, IP pools, Felix agent)
- **But**: network policies are not needed on a single-node without multi-tenancy. All apps are trusted, there is no tenant to isolate
- **But**: BGP routing has no purpose on a single-node — Calico would fall back to VXLAN mode, like Flannel but heavier

**Cilium** (rejected):
- The richest: eBPF for networking (kernel-level performance), Hubble for L7 observability, kube-proxy replacement (one fewer component), integrated LB (would replace MetalLB — ADR 0007)
- On paper, Cilium does everything: CNI + network policies + observability + LB + kube-proxy replacement. Technically the most elegant solution
- **But**: ~200-300MB RAM for the CNI alone, more if Hubble is enabled — disproportionate on a 4-8GB VPS
- **But**: significant operational complexity. eBPF requires a recent and compatible kernel, debugging is less accessible, configuration is vast
- **But**: steep learning curve. On a learning setup, it's better to understand each component separately (CNI, LB, kube-proxy) before merging them into Cilium

### Migration Path

The choice of Flannel is not final. If the setup evolves to multi-node or network observability needs arise, migration to Cilium is a documented operation. Pods are rescheduled, the network is recreated, workloads do not change. The migration cost is low compared to the simplicity gained now.

## Consequences

- No network policies — acceptable on a single-node without multi-tenancy. To reconsider if untrusted workloads are added
- kube-proxy remains necessary (Flannel does not replace it) — one more component than if Cilium had been chosen
- MetalLB (ADR 0007) is required for load balancing — Flannel does not provide this functionality (Cilium would have included it)
- Pod-to-pod networking is a simple VXLAN overlay, no native L7 observability — network debugging uses classic tools (kubectl logs, tcpdump)
- Flannel is deployed by Flux like all other components (ADR 0001, ADR 0002)
