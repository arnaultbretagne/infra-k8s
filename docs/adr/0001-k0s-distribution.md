# ADR 0001 — k0s as Kubernetes Distribution

## Status

Accepted

## Context

Need for a single-node Kubernetes cluster on a VPS with limited resources (4-8GB RAM).
Options evaluated: k3s (Rancher/SUSE), k0s (Mirantis), MicroK8s (Canonical).

The cluster is fully managed by Flux (ADR 0002): all system components (ingress, storage, monitoring) are declared in the GitOps repo. This is a decisive point as it creates an architectural tension with "batteries included" distributions: if Flux is the source of truth, pre-installed components must be disabled then re-deployed via GitOps.

## Decision

k0s.

## Rationale

### Detailed Comparison

Three lightweight distributions were evaluated on the following criteria: philosophy (batteries included vs minimal), GitOps coherence, memory footprint, system dependencies, and update mechanism.

| Criteria | k0s | k3s | MicroK8s |
|---|---|---|---|
| Philosophy | Minimal, empty cluster | Batteries included | Opt-in addons |
| Pre-installed components | None | Flannel, Traefik, ServiceLB, CoreDNS, local-path | None (but opaque addons) |
| Single binary | Yes | Yes | No (snap) |
| System dependency | None | None | **snapd** |
| Idle RAM | ~300MB | ~500-600MB | ~500-600MB |
| Single-node datastore | SQLite via Kine | SQLite via Kine | dqlite |
| HA datastore | Embedded etcd | Embedded etcd | Distributed dqlite |
| Updates | **Autopilot** (declarative CRD) | Manual or System Upgrade Controller | `snap refresh` (automatic, uncontrolled) |
| Community | ~20k stars, Mirantis | ~30k stars, SUSE/Rancher | ~9k stars, Canonical |

**k0s** (chosen):
- Minimal by design: no pre-installed components, the cluster starts empty and Flux deploys everything
- GitOps coherent: no components to disable, no reconciliation loop conflicting with Flux
- Single binary, 30-second installation, zero system dependencies
- Lowest memory footprint (~300MB idle, the lightest of the three)
- Autopilot: k0s can update itself declaratively via a CRD, coherent with the GitOps approach
- SQLite datastore via Kine in single-node — lightweight, no separate etcd process

**k3s** (rejected):
- Good tool, largest community, abundant documentation
- Batteries included (Flannel, Traefik, ServiceLB, local-path-provisioner) — convenient for getting started in 30 seconds
- **But**: these pre-installed components are managed by k3s, not by Flux. This creates two concurrent reconciliation loops on the same cluster. In practice, k3s components must be disabled (`--disable=traefik --disable=servicelb --disable=local-storage`) to re-deploy them via Flux. The "batteries included" argument loses its value when you disable them all
- The embedded Traefik does not support Gateway API (ADR 0004) without reconfiguration, reinforcing the need to disable it
- Manual updates or via System Upgrade Controller (less elegant than k0s Autopilot)

**MicroK8s** (rejected):
- Opt-in addon model (`microk8s enable ingress`) — philosophically closer to k0s
- **But**: heavy dependency on **snapd**. On a minimal Debian/Ubuntu VPS, installing snap just for K8s is disproportionate. On a non-Ubuntu distro, it's even worse
- **But**: addons are **opaque shell scripts** that run `kubectl apply` — they bypass Flux exactly like k3s components, but in an even less transparent way (no declarative config, no versioning)
- **But**: automatic and uncontrolled `snap refresh` — risk of unwanted production updates
- Memory footprint comparable to k3s (~500-600MB), significantly more than k0s

### The choice boils down to

If Flux manages everything (ADR 0002), it's better to start from an empty cluster rather than disabling pre-installed components. k0s is the only one of the three designed for this.

## Consequences

- The CNI must be installed by Flux (Flannel — ADR 0006)
- The ingress controller must be installed by Flux (Traefik — ADR 0008)
- The load balancer must be installed by Flux (MetalLB — ADR 0007)
- The storage provisioner must be installed by Flux if needed (local-path-provisioner)
- The datastore is SQLite via Kine — encryption at rest uses EncryptionConfiguration (ADR 0011), not native etcd encryption
- 100% of cluster components are declared in the GitOps repo — reconstruction from scratch is trivial
- If scaling to multi-node, k0s natively supports adding workers and automatically switches to embedded etcd
