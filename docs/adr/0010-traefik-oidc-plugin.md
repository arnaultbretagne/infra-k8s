# ADR 0010 — Traefik OIDC Plugin for ForwardAuth

## Status

**Superseded by [ADR 0021](0021-oauth2-proxy-oidc-gate.md) (2026-06-30).** The plugin is a
`traefik.io` Middleware CRD, which conflicts with our pure-Gateway-API Traefik (`kubernetesCRD:
false`); it failed in practice. We use **oauth2-proxy** instead. Original decision preserved below.

## Context

Pocket-ID (ADR 0009) is a pure IdP — it provides OIDC identity but cannot intercept HTTP requests. An intermediary component is needed for Traefik's ForwardAuth pattern (ADR 0008): intercept each request, verify the session, redirect to Pocket-ID if unauthenticated.

Options evaluated: oauth2-proxy, traefik-forward-auth (thomseddon), sevensolutions/traefik-oidc-auth plugin.

## Decision

sevensolutions/traefik-oidc-auth plugin.

## Rationale

### Detailed Comparison

Three solutions were evaluated in depth on the following criteria: architecture, features, Pocket-ID integration, footprint, and maturity.

**traefik-forward-auth (thomseddon)** (2.4k stars):
- Designed specifically for Traefik ForwardAuth, very lightweight (~5-10MB)
- **Eliminated**: no longer maintained (last feature in 2020, only dependency bumps since). No support for group filtering (issue #162 open since 2020, never implemented). Deal-breaker for per-app access control

**oauth2-proxy** (14k stars):
- The de facto standard, very mature, large community
- Native group filtering (`--allowed-group`), PKCE, token refresh, Redis session
- Prometheus metrics, health checks, server-side session revocation via Redis
- Documented Pocket-ID integration
- **But**: separate pod (~20-40MB RAM) + Service + `/oauth2/` route to configure
- **But**: forwarding headers limited to a predefined set (`X-Forwarded-*`)
- **But**: OIDC logout must be built manually (pass `rd` URL yourself)
- **But**: authorization limited to groups + email domain + email allowlist

**sevensolutions/traefik-oidc-auth plugin** (333 stars):
- In-process Traefik plugin — runs inside the Traefik process, zero additional container
- Pocket-ID integration explicitly tested and documented (dedicated page)
- Rich authorization: `AssertClaims` with JSONPath, `AnyOf`/`AllOf` quantifiers — more powerful than oauth2-proxy's `--allowed-group`
- Full template headers: Go templates with access to any OIDC claim — more flexible than oauth2-proxy's predefined headers
- Proper OIDC logout: automatic RP-Initiated Logout with `id_token_hint`, no manual URL construction
- Automatic token refresh (configurable threshold as percentage of token lifetime)
- PKCE supported (but known bug #170 with Pocket-ID — workaround: disable PKCE on Pocket-ID side)
- Authentication bypass per route (`BypassAuthenticationRule` with matching on Method, Path, Headers, SourceIP) — useful for API endpoints (e.g., iOS Shortcut with application API key)
- `UnauthorizedBehavior: Auto` distinguishes browser requests (redirect) from API requests (401)

### What the Plugin Does NOT Do (vs oauth2-proxy)

| Missing feature | Actual impact for a single-node homelab |
|---|---|
| No Redis session — tokens in cookie (~4-5KB) | Negligible with a few users. Minimal additional bandwidth |
| No server-side session revocation | Low risk. Session expires naturally. No immediate revocation use case when solo |
| No Prometheus metrics | No auth rate monitoring. Acceptable without an advanced monitoring stack |
| No dedicated health check | The plugin lives in Traefik which has its own liveness/readiness probes |
| No JWT bearer passthrough | Not needed — API clients (e.g., iOS Shortcuts) use route bypass + application auth (API key) rather than pre-existing OIDC JWTs |

These limitations are acceptable on a single-node setup with few users. None are structurally blocking.

### Why the Plugin Over oauth2-proxy

1. **Zero additional infrastructure** — no Deployment, no Service, no HelmRelease. Auth lives in Traefik. One fewer component to deploy, monitor, update
2. **Simpler config** — one Traefik `Middleware` block vs 12+ env vars + `/oauth2/` routing
3. **Richer authorization** — JSONPath claim assertions vs simple group filtering
4. **Automatic OIDC logout** — vs manual URL construction with oauth2-proxy
5. **Flexible headers** — Go templates on any claim vs predefined set
6. **First-class Pocket-ID support** — dedicated doc, tested by the maintainer

The main risk is maturity (333 stars, project started in 2024). This risk is mitigated by:
- The plugin is stateless — migrating to oauth2-proxy = replacing a Middleware with a Deployment, no data migration
- The scope is limited (OIDC ForwardAuth), less surface for critical bugs than a full proxy
- The project is actively maintained (v0.18.0 in February 2026, regular releases)

## Consequences

- The plugin is declared in the Traefik config (Traefik HelmRelease, ADR 0008), not as a separate pod
- Each protected app references a Traefik Middleware with its specific `AssertClaims` config (authorized groups)
- Programmatic API endpoints (e.g., clipper for iOS Shortcuts) use `BypassAuthenticationRule` and manage their own application auth
- PKCE disabled on the Pocket-ID side until bug #170 is resolved
- If the plugin is abandoned or insufficient, migration to oauth2-proxy with no impact on the rest of the stack (HTTPRoutes, Pocket-ID, groups)
