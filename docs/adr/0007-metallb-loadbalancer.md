# ADR 0007 — MetalLB as Load Balancer

## Status

Accepted

## Context

On a bare-metal VPS, there is no cloud provider to assign IPs to `Service type: LoadBalancer`. Without a solution, these services remain in `<pending>` indefinitely. This is a problem because Traefik (ADR 0008) needs a LoadBalancer Service to receive external traffic.

Options evaluated: MetalLB, kube-vip, Cilium LB.

Note: if Cilium had been chosen as CNI (ADR 0006), its integrated LB would have made this choice unnecessary. With Flannel, a dedicated LB is required.

## Decision

MetalLB in L2 mode.

## Rationale

### Detailed Comparison

Three solutions were evaluated on the following criteria: operating mode, simplicity, single-node vs multi-node relevance, and memory footprint.

| Criteria | MetalLB | kube-vip | Cilium LB |
|---|---|---|---|
| L2 (ARP) mode | Yes | Yes | Yes |
| BGP mode | Yes | Yes | Yes |
| Floating VIP (HA) | No (not its role) | **Yes** (leader election) | No |
| Control plane HA | No | **Yes** (VIP for API server) | No |
| Dependency | Standalone | Standalone | **Cilium CNI required** |
| RAM | ~50-100MB | ~30-50MB | ~0 (integrated in Cilium) |
| Community | **~8k stars**, very large | ~2k stars | Part of Cilium (~20k) |
| Config CRDs | `IPAddressPool`, `L2Advertisement` | ConfigMap or flags | `CiliumLoadBalancerIPPool` |

**MetalLB in L2 mode** (chosen):
- De facto standard for bare-metal, very wide adoption and documentation
- L2 mode: responds to ARP requests with the MAC address of the node carrying the Service. Simple, no need for BGP or advanced network configuration — ideal for single-node
- On a VPS with a single public IP, MetalLB assigns this IP to LoadBalancer Services. This is exactly the desired behavior: traffic arrives at the VPS IP and MetalLB directs it to Traefik
- Declarative configuration via CRDs (`IPAddressPool` + `L2Advertisement`), coherent with the GitOps approach
- Lightweight (~50-100MB RAM)

**kube-vip** (rejected):
- Primarily designed to provide a **floating VIP** for the K8s control plane in HA (if the master goes down, the VIP migrates to another master). Can also serve as a Service LB
- Very lightweight (~30-50MB), lighter than MetalLB
- **But**: its added value (floating VIP, leader election) has no purpose on single-node — there is only one node, the VIP cannot migrate anywhere
- **But**: smaller community, less documentation for the "Service LB" use case
- **But**: configuration is less intuitive than MetalLB CRDs (flags on the DaemonSet or ConfigMap)
- Would become relevant if scaling to multi-node with control plane HA needs

**Cilium LB** (rejected):
- LB integrated into the Cilium CNI — zero additional component, zero extra RAM
- The most elegant architectural solution: the CNI that also handles LB
- **But**: requires Cilium as CNI. We chose Flannel (ADR 0006) for its simplicity. Deploying Cilium just for the LB would be inconsistent
- Would become relevant again if migrating to Cilium as CNI

### L2 vs BGP Mode

MetalLB supports two modes. L2 mode is chosen because:
- **L2 (ARP)**: a node "announces" itself as the IP owner via ARP. Simple, works on any network, no router/switch configuration needed. Limitation: all traffic goes through a single node (no L3 load balancing)
- **BGP**: MetalLB announces IPs via BGP to routers. Enables true L3 multi-node load balancing. Requires a BGP-compatible router — not available on a standard VPS

On a single-node, the L2 limitation (single node) is not a limitation since there is only one node.

## Consequences

- An `IPAddressPool` must be configured with the VPS IP, and an `L2Advertisement` must reference that pool
- In L2 mode, a single node responds to ARP requests for the IP — not a limitation on single-node, but to reconsider for multi-node (switch to BGP or Cilium LB)
- MetalLB is deployed by Flux like all other components (ADR 0001, ADR 0002)
- If migrating to Cilium (ADR 0006), MetalLB can be removed in favor of the integrated LB
