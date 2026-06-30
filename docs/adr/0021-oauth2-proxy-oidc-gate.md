# ADR 0021 — OIDC access gate: oauth2-proxy (supersedes ADR 0010)

## Status

Accepted — 2026-06-30. **Supersedes [ADR 0010](0010-traefik-oidc-plugin.md)** (sevensolutions
traefik-oidc-auth plugin).

## Context

ADR 0010 chose the **sevensolutions/traefik-oidc-auth plugin** to gate apps with OIDC (Pocket-ID),
its main selling point being *in-process* (no extra pod, runs inside Traefik).

Building the first gated app (the agent-runtime MVP at `agent.bretagne.dev`), that choice **failed
in practice**:

- The plugin is wired as a **Traefik `Middleware`** (`traefik.io/v1alpha1` CRD), attached to a route.
- But our Traefik runs **pure Gateway API** — `providers.kubernetesCRD.enabled: false` (ADR 0004 /
  0008), and the `traefik.io` Middleware CRD **is not even installed**.
- Using the plugin would require **enabling the Traefik CRD provider + installing the Middleware CRD
  + RBAC for it + attaching via HTTPRoute `ExtensionRef`** — i.e. **reversing the pure-Gateway-API
  decision** and re-introducing `traefik.io` CRDs, just to get an auth middleware.

That is a real architectural regression for what should be a small access gate.

## Decision

**Use `oauth2-proxy` as the OIDC access gate**, as a normal backend in front of each protected app:

```
HTTPRoute (app.bretagne.dev) → oauth2-proxy (Service) → [authenticated] → the app
```

oauth2-proxy performs the OIDC flow against Pocket-ID itself and reverse-proxies authenticated
traffic upstream. It is **Gateway-API-native** — just a Deployment + Service + an HTTPRoute pointing
at it. **No Traefik `Middleware` CRD, no CRD provider, no Traefik release change.**

Validated end-to-end on `agent.bretagne.dev` (OIDC redirect → Pocket-ID passkey → upstream). Config
that mattered:

- `OAUTH2_PROXY_PROVIDER=oidc`, `OIDC_ISSUER_URL=https://id.bretagne.dev`.
- `PROXY_PREFIX=/oidc` → callback at `/oidc/callback` (matches the Pocket-ID client redirect URI).
- `INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL=true` — **Pocket-ID does not set `email_verified`**, and
  oauth2-proxy rejects unverified emails by default (caused a 500 at callback until set).
- `REVERSE_PROXY=true`, `COOKIE_SECURE=true`. `client_id` + `client_secret` + `cookie_secret` in SOPS.

## Rationale

- **The plugin's only real edge is moot here.** "In-process, no extra pod" is worthless if it costs
  the **entire pure-Gateway-API posture** (CRD provider + Middleware CRD + RBAC). ADR 0010 listed
  oauth2-proxy's "separate pod (~20–40 MB) + Service + route" as a downside — that downside is far
  **cheaper than reversing Gateway-API-only**.
- **oauth2-proxy is the de-facto standard**: mature, native group filtering (`--allowed-group`),
  PKCE, token refresh, documented Pocket-ID integration.
- **It actually works on our stack** — proven, not theoretical. The plugin did not.
- **WebSockets pass through** (`--proxy-websockets`, default on) — needed for the agent UI.

## Consequences

- The OIDC gate is **oauth2-proxy in front of each protected app** (HTTPRoute → oauth2-proxy → app).
  Whether to run **one instance per app** or **a shared instance** with multiple upstreams is left
  open (per-app is simplest + isolates cookies; revisit if app count grows).
- **Traefik stays pure Gateway API** — `kubernetesCRD: false` preserved, no `traefik.io` CRDs
  re-introduced. ADR 0008's posture holds.
- Pocket-ID clients use redirect URI `https://<app>/oidc/callback`; the client needs the
  `allow-unverified-email` workaround on the proxy side until Pocket-ID emits `email_verified`.
- The `oauth2-proxy` manifests (deployed directly during the MVP) are to be **GitOps-ified** with the
  app they gate (e.g. the agent app).
- ADR 0010 is **superseded** (its rich `AssertClaims`/JSONPath authorization is lost; oauth2-proxy's
  group/email authorization is sufficient for our needs — revisit only if finer claim-based rules are
  required).
