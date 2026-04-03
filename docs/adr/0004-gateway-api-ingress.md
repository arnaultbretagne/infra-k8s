# ADR 0004 — Gateway API as Ingress Standard

## Status

Accepted

## Context

Two K8s specs for managing incoming traffic: the Ingress resource (legacy) and Gateway API (successor). The controller used is Traefik, deployed by Flux (ADR 0001, ADR 0002).

## Decision

Gateway API.

## Rationale

- Modern standard, GA, official successor to the Ingress resource
- More expressive: header matching, traffic splitting (canary/blue-green), multi-protocol (HTTP, gRPC, TCP, TLS) — native without custom annotations
- Role separation: GatewayClass (infra) → Gateway (ops) → HTTPRoute (dev)
- Portable: same YAML regardless of controller (Traefik, Cilium, nginx, etc.)
- Extensible via typed CRDs instead of unvalidated string annotations
- Traefik supports Gateway API natively
- Investing in the modern spec rather than the legacy one (learning perspective)

## Consequences

- Gateway API CRDs and Traefik are deployed by Flux (no pre-installed component with k0s)
- HTTPRoutes replace Ingress resources in all manifests
- If the controller is changed in the future, routes remain identical
