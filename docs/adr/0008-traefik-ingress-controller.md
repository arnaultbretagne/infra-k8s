# ADR 0008 — Traefik as Ingress Controller

## Status

Accepted

## Context

ADR 0004 chose Gateway API as the routing standard. Gateway API is a spec — a controller (the implementation) is needed to run it.

With k0s (ADR 0001), no ingress controller is pre-installed. The controller choice also impacts the TLS strategy (integrated ACME or external cert-manager).

The current infrastructure uses a ForwardAuth to Pocket-ID (ADR 0009) to protect certain apps. The controller must natively support this pattern.

Options evaluated: Traefik, nginx-gateway-fabric, Envoy Gateway, Caddy (caddy-ingress).

## Decision

Traefik.

## Rationale

- **Complete and GA Gateway API** — native support, not an addon
- **Integrated ACME** — Traefik handles Let's Encrypt certificates itself, no need for cert-manager (one fewer component and ~50MB RAM saved)
- **Native middlewares (CRDs)** — ForwardAuth, rate-limit, security headers, redirect, compress, IP whitelist... declarative and chainable. This is a concrete need: the ForwardAuth to Pocket-ID (ADR 0009) requires a request interception middleware
- **Integrated dashboard** — routing debug without external tools
- **Large K8s community** — abundant documentation, especially for lightweight/homelab setups
- **~100-150MB RAM** — reasonable for single-node

### Rejected Alternatives

**nginx-gateway-fabric:**
- Official K8s SIG implementation, clean and streamlined
- Gateway API only (no legacy Ingress)
- **Eliminated because**: no native middlewares. No ForwardAuth, no rate-limit, no header manipulation via CRDs. To protect apps via Pocket-ID, an additional external component or non-standard hacks would be needed. ~100MB RAM

**Envoy Gateway:**
- Gateway API reference implementation, backed by Google
- Rich CRDs (AuthFilter, RateLimit)
- **Eliminated because**: ~200MB RAM, disproportionate complexity for single-node. Oriented toward large multi-team clusters

**Caddy (caddy-ingress-controller):**
- Zero-config automatic TLS (Caddy heritage), very lightweight (~50MB)
- This is what the current infrastructure uses (authcrunch = Caddy)
- **Eliminated because**: experimental/incomplete Gateway API support. Risk of having to revert ADR 0004 or maintain legacy Ingress resources. Niche K8s community

### Note on TLS

Traefik with integrated ACME avoids deploying cert-manager. Certificates are managed directly by Traefik (Let's Encrypt resolvers, storage in a K8s Secret). This reduces the operational surface. If certificate needs beyond ingress arise (mTLS between services, webhook certificates), cert-manager can be added later.

## Consequences

- Traefik is deployed by Flux as a HelmRelease (ADR 0001, ADR 0002)
- Routes use Gateway API HTTPRoutes (ADR 0004), not Traefik IngressRoute CRDs
- Middlewares (ForwardAuth, headers, rate-limit) use Traefik CRDs — this is the only non-standard Gateway API part
- If the controller is changed in the future, HTTPRoutes remain identical but Middlewares would need to be re-implemented
- No cert-manager at bootstrap — Traefik handles TLS via ACME
