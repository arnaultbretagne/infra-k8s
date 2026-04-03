# ADR 0009 — Pocket-ID as Identity Provider

## Status

Accepted

## Context

The infrastructure needs an identity provider (IdP) to authenticate users on exposed services (monitoring, code-server, stremio, etc.) via Traefik's ForwardAuth pattern (ADR 0008).

Selection criteria:
- Passkey (WebAuthn/FIDO2) support at minimum as an option, ideally as the primary method
- OIDC provider for integration with oauth2-proxy and apps
- Lightweight (resource-limited single-node VPS)
- Simple admin interface
- ACLs: control over who accesses which app

Options evaluated: Pocket-ID, Authelia, Kanidm, Authentik, Zitadel, Keycloak, Hanko.

## Decision

Pocket-ID.

## Rationale

### Full Comparison

Seven solutions were evaluated on the following criteria: passkey support, auth model, memory footprint, dependencies, admin interface, ForwardAuth integration, and ACLs.

**Pocket-ID** (~30-50MB, embedded SQLite, 7k stars):
- Passkey-first by design — it is the only authentication method, no passwords in the system
- Native OIDC provider, integrates with oauth2-proxy for Traefik ForwardAuth
- Complete web admin UI: user, group, OIDC client management with logo upload, audit log
- ACLs via "Allowed User Groups" per OIDC client + `groups` claim in the token for proxy-side filtering
- Zero external dependencies (SQLite), single container
- Login UX: immediate browser passkey prompt, zero fields to fill (discoverable credentials)

**Authelia** (~20-30MB, SQLite or PG, 27k stars):
- Native auth proxy — integrates directly as ForwardAuth with Traefik without an intermediary component (single pod)
- Powerful policy engine (ACLs per domain, path, HTTP method, network, group)
- Flexible MFA (TOTP, WebAuthn, Duo)
- OpenID Certified, very mature
- **But**: passkeys count as single-factor only — if the policy requires 2FA, the user must still enter a password after the passkey. AMR support (to treat a passkey as sufficient) is planned ~v4.41 but not yet shipped
- **But**: no admin interface — everything is in YAML files (users, OIDC clients, policies). An admin dashboard is on the roadmap (design stage)
- **But**: no conditional UI (passkey autofill in the browser) — planned v4.41-42
- Login UX: classic username + password form, with a "Sign in with passkey" button next to it

**Kanidm** (~30-50MB, Rust embedded DB, 4.7k stars):
- Most granular passkey enforcement (policy `credential_minimum_class: passkey` or `attested_passkey`)
- Very lightweight, written in Rust, zero external dependencies
- OAuth2/OIDC provider + LDAP + RADIUS
- **But**: still in beta (v1.1.0-beta), possible breaking changes, developer-oriented documentation, small community
- Pure IdP, requires oauth2-proxy for ForwardAuth

**Authentik** (~800MB-2GB, PostgreSQL required, 20k stars):
- Integrated ForwardAuth proxy (like Authelia), very rich admin UI
- Passkey-only possible via custom authentication flows
- **Eliminated**: memory footprint 20-50x higher than alternatives, mandatory PostgreSQL. Disproportionate for a single-node VPS

**Zitadel** (~512MB + PostgreSQL, 13k stars):
- Multi-tenant, modern cloud-native architecture
- **Eliminated**: passkey-only enforcement not yet implemented (open issue #8996). Too heavy (PG required, ~2-4GB total)

**Keycloak** (~1-1.5GB + PostgreSQL, 33k stars):
- Industry reference for OIDC/SAML, passkey possible via custom flows
- **Eliminated**: JVM at ~1.5GB minimum + PostgreSQL. Designed for enterprise, overkill for a homelab

**Hanko** (~50-100MB + PostgreSQL, 8.9k stars):
- Passkey-first, config `passwords: off` to enforce passkey-only
- OIDC provider
- **Eliminated**: SDK/API-oriented for integration into custom apps, not as an infrastructure IdP to protect existing services. PostgreSQL required

### Why Pocket-ID Over Authelia

The tiebreak was between these two. Authelia has the technical edge (native ForwardAuth, policy engine, maturity). Pocket-ID wins on:

1. **Login UX** — immediate passkey prompt vs username/password form with a passkey button on the side. On a personal setup, this is the screen you see every day
2. **Admin UI** — full web management vs everything in YAML. Adding an OIDC client or user in a few clicks vs editing a file and redeploying
3. **Native passkeys** — passkey-first by design vs passkey as a single-factor option that doesn't satisfy 2FA policies
4. **Sufficient ACLs** — "Allowed User Groups" per OIDC client covers the need (restrict access per app and per group), even if less granular than Authelia's policy engine

The additional cost (oauth2-proxy, ~20MB) is negligible compared to the daily UX gains.

## Consequences

- Pocket-ID is deployed by Flux as a HelmRelease (or Kustomization)
- oauth2-proxy is deployed alongside for Traefik ForwardAuth (ADR 0008)
- Pocket-ID groups replace the current `oidc_groups` from stacks.yaml (admin, monitoring, stremio, code)
- The `groups` claim in the OIDC token enables additional filtering on the oauth2-proxy side (`--allowed-group`)
- No password management, no password reset — passkeys only. Users must have a WebAuthn-compatible device
- If Authelia ships AMR support + admin UI + conditional UI (planned ~v4.41-42), the decision can be re-evaluated
