# ADR 0009 — Pocket-ID as Identity Provider

## Status

Accepted — **amended 2026-06-28** (operational model: stateful / DB-backed / backup-driven recovery — see end of doc). Runs on CloudNativePG Postgres (ADR 0012), **not** the embedded SQLite mentioned below.

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

---

## Amendment 2026-06-28 — Operational model: stateful, DB-backed, backup-driven recovery (NOT config-as-code)

Records how we *run and recover* Pocket-ID (the selection above stands). Written so we never re-derive it.

**Runs on Postgres (CNPG), not embedded SQLite.** Per ADR 0012, Pocket-ID v2 runs against a CloudNativePG cluster. **All** Pocket-ID state — users, passkeys, OIDC clients (+ secrets), groups, app config (incl. SMTP) — lives in that DB.

**Pocket-ID is treated as a stateful app — we do NOT do config-as-code for it.**
- Pocket-ID has no native config-as-code: clients/groups are UI/API-only. The Docker-era setup scripted the API (idempotent bash reconcilers). We **reject re-importing that** — it is exactly the brittle bordel we're migrating away from, for an IdP whose config changes a few times a year.
- **The DB is the source of truth.** Config is done in the Pocket-ID **UI** (admin = the human). We accept losing PR-auditability of IdP config; the alternative (API-scripting) costs more than it's worth here.

**Reproducibility = git-deploy + S3-restore (declarative, zero bash).**
- **Git** holds: the k8s manifests (Deployment, CNPG `Cluster`, Service, HTTPRoute), the `ENCRYPTION_KEY` (SOPS), and — for DR — a CNPG `bootstrap.recovery` pointing at the S3 backup.
- **Rebuild on a vierge VPS:** Flux deploys → CNPG **restores the DB from S3** → `ENCRYPTION_KEY` decrypts → Pocket-ID comes back whole (users, passkeys, clients, groups, SMTP). No provisioning scripts.

**Secrets vs backup — the split.**
- **SOPS/git = `ENCRYPTION_KEY` only** (ADR 0011). It is the *one* secret that cannot live in the DB, because it is what encrypts the DB at rest — hence the linchpin that makes the S3 backup usable.
- **DB → S3 backup (ADR 0012) = everything else**: SMTP credentials, OIDC client secrets, users, passkeys (public keys), groups, app config — all encrypted at rest by `ENCRYPTION_KEY`.
- **Postgres credentials = CNPG-managed k8s secret** (not git).
- Mnemonic: **the key in git, the data in S3, CNPG manages its own lock.**

**Passkeys are domain-bound; the genesis is irreducibly manual.**
- A WebAuthn passkey is bound to the RP ID = the domain (`id.bretagne.dev`). It can only be enrolled once that domain is served by this instance → **at/after the edge flip (Phase 7)**, never via a `localhost` port-forward (RP ID would be localhost, useless after).
- The IdP **genesis** — first admin + first passkey + first API key + initial UI config — **cannot be GitOps'd** (it is the root of trust; a human establishes it once). Normal and accepted. The restore-test (ADR 0012) validates the only irreplaceable thing: the user data (passkeys).

**Cutover from the old Docker Pocket-ID — FRESH, no migration.**
- The old instance was **SQLite in Docker** (`reverse-proxy_pocket_id_data`), **never** backed up to the new S3 → "restore from backup" is not available for the old data.
- Inventory (extracted 2026-06-28, kept only as reference): **2 users** (arnault [admin], maxime.noulin [admin]), **2 passkeys** (1 each), **3 OIDC clients** (`client_vps` → VPS forward-auth; `claude_auth` → claude.ai MCP; `openai_auth` → chatgpt.com connector), **4 groups** (only `admin` used; `stremio`/`claude`/`beszel` were empty cruft).
- **Decision: start FRESH** — no SQLite→Postgres migration. Re-enroll passkey(s), redefine groups/clients natively in the UI. Rationale: tiny scale, goal is a clean native setup (no old cruft), and the first admin re-enrolls a passkey at genesis anyway.
- From the old `.env`, `client_vps`'s client_id + secret are recoverable → re-wiring the VPS forward-auth is **transparent**. The **two external connectors** (Claude, ChatGPT) get a new id/secret → **must be re-authorized** on those platforms (Pocket-ID stores only secret hashes; plaintext isn't recoverable).
- Going forward likely single-user (Maxime's access is the human's call) → possibly just `admin`, maybe no groups at all.

## Amendment 2026-07-02 — single-instance ⇒ `strategy: Recreate`; break-glass

- **Pocket-ID refuses to run two instances** ("running multiple replicas is currently not supported").
  The Deployment MUST use `strategy: { type: Recreate }`; the default RollingUpdate briefly runs two
  pods and **deadlocks every rollout** (learned the hard way — a ~2-min IdP outage). Single replica ⇒
  a rollout always has a short blip; accepted.
- **Break-glass**: the admin is a single passkey bound to `id.bretagne.dev`. Losing that device locks
  the IdP out (a DB restore doesn't re-mint a usable passkey). Enrol a **second passkey** on a cold
  device, and/or keep documented direct-DB admin access. TODO.
