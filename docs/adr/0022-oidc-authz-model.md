# ADR 0022 — OIDC Authorization Model & Client Management

## Status

**Proposed — 2026-07-02.** Draft for review. Builds on [ADR 0009](0009-pocket-id-identity.md)
(Pocket-ID as IdP) and [ADR 0021](0021-oauth2-proxy-oidc-gate.md) (oauth2-proxy as the gate).
Nothing here is enforced yet; this ADR fixes the *model* so the concrete gaps below can be
closed consistently instead of ad-hoc.

## Context

Access to every internet-facing app is meant to be gated by Pocket-ID (OIDC). Auditing the live
state (2026-07-02) showed the plumbing works but the **authorization model was never made
explicit**, so it drifted:

- **Three enforcement mechanisms coexist**, at different layers, and it wasn't written down which
  applies where:
  1. **Pocket-ID client↔group restriction** (`oidc_clients.is_group_restricted` +
     `oidc_clients_allowed_user_groups`) — IdP-side. Pocket-ID refuses to mint a token for a client
     unless the user is in an allowed group. This is the *primary* filter.
  2. **oauth2-proxy** (ADR 0021) — reverse-proxy gate for apps with no native OIDC. Can add its own
     `--allowed-groups` / email filter.
  3. **App-native OIDC** — the app speaks OIDC itself and maps groups→roles (Grafana).
- **The live authz state is inconsistent** (all 3 clients created by hand via the Pocket-ID admin UI,
  `created_by = arnault`):

  | App | Gate | Pocket-ID client | Group-restricted? |
  |---|---|---|---|
  | agent | oauth2-proxy | `agent` | ✅ `admin` |
  | code-server | oauth2-proxy | `code-server` | ✅ `admin` |
  | grafana | native OIDC | `grafana` | ❌ **no** — any Pocket-ID user |
  | stremio (aiostreams) | **none — public** | — | ❌ no client at all |
  | obsidian (vault) | ??? | **none** | ❌ no client — auth mechanism unverified |

- **Client definitions live only in the Pocket-ID database — not in Git.** Their config (redirect
  URIs, group restriction) is neither version-controlled nor code-reviewed. The un-restricted Grafana
  client was found by inspecting the DB, not by reading a manifest — that is the drift symptom.
  (Client *secrets* are fine: each is in SOPS. It's the client *definition/policy* that's out-of-band.)
- The lab will not stay single-user: one **admin** (operator) but also future **media users** for
  stremio. Authz must scale to "different audiences, different apps" cleanly.

## Decision

1. **One OIDC client per app (relying party).** Each protected app gets its own Pocket-ID client —
   own `client_id`/secret, own redirect URI, own group restriction. Blast radius stays contained and
   the group restriction is a per-app knob. This is already the shape (agent, grafana, code-server);
   we make it a rule.

2. **One oauth2-proxy instance per protected app** (not a shared proxy). A shared proxy would collapse
   several apps onto one client and lose per-app authz. This resolves the open question left in
   ADR 0021 (§Consequences).

3. **Pocket-ID groups are the single source of truth for authorization.** Membership is managed in
   *one* place (the IdP). Each client is restricted to its allowed group(s) via Pocket-ID's client
   group-restriction — **this is the primary filter**: a non-member never receives a token, so the app
   never sees the request. Adding/removing a user from a group grants/revokes access everywhere that
   group applies.

4. **Group model** (start small, extend as needed):
   - `admin` — operators; full access to operational apps (agent, code-server, grafana, pocket-id, …).
   - `stremio-users` — media consumers; access to stremio only (if/when stremio is gated).
   - New audiences → new group + restrict the relevant client(s) to it.

5. **Enforcement point per app type** — the group is the knob; *where* it's checked depends on the app:
   - **oauth2-proxy apps** (agent, code-server): primary filter = Pocket-ID client restriction.
     *Optional* defense-in-depth = mirror `OAUTH2_PROXY_ALLOWED_GROUPS` at the proxy — **only after
     verifying the `groups` claim actually flows** (needs `groups` in scope; verify with a real token
     to avoid a lockout). Low priority: the IdP restriction is already the real gate.
   - **native-OIDC apps** (grafana): Pocket-ID client restriction **and** the app's own group→role
     mapping (admin/editor/viewer). Both needed — restriction for *access*, mapping for *privilege*.
   - **public apps**: an explicit, documented choice (see stremio), not an accident.

6. **Client definitions must become reviewable in Git.** The DB-only status quo is the drift source.
   Two options — **decision to confirm on review**:
   - **(a) Declarative reconcile (target).** A Git-versioned spec (name, redirect URIs, allowed
     groups, public/PKCE) reconciled into Pocket-ID by an idempotent Flux-managed Job hitting the
     Pocket-ID **API** (admin token in SOPS). Declarative, reviewable, reproducible — the GitOps-native
     answer, consistent with single-source-of-truth. Cost: build + maintain the reconciler, hold an
     admin API token.
   - **(b) Documented registry (interim).** Keep creating clients via the admin UI, but record each
     one — its redirect URIs and required group — in a versioned `docs/oidc-clients.md`, reviewed on
     change. Zero new machinery; **not enforced** (drift still possible, doc can lag).

   **Decision (2026-07-02): (a).** Go declarative from the start — a versioned client spec reconciled
   into Pocket-ID by a Flux-managed CronJob via the API (admin key in SOPS). Rationale: this cluster is
   agent-operated and single-source-of-truth is a core value; a documented registry (b) would drift the
   same way the Grafana client already did. Scope note: the reconciler manages client **policy**
   (callback URLs, group restriction) and **groups**; it does **not** rotate existing client secrets,
   and bootstrapping the secret of a brand-new client stays a documented manual step (Pocket-ID mints it
   at creation; it must be copied into that app's SOPS by hand).

## Rationale

- **Single source of truth beats scattered checks.** One group membership in the IdP, versus
  per-app email lists / role configs, is fewer places to get wrong and the natural revoke-everywhere
  primitive.
- **The IdP restriction is the strongest link** — it fails *closed* at token issuance, before any app
  code runs. oauth2-proxy `allowed_groups` and app role-maps are belt-and-suspenders on top.
- **Per-app client + per-app proxy** keep blast radius and policy independent, at the cost of a few
  extra small Deployments — cheap on this cluster and consistent with ADR 0021's reasoning.
- **Declarative client config** is the same argument that drove SOPS-in-Git (ADR 0003) and copyFrom
  single-source secrets (ADR 0012): if it's policy, it belongs in a reviewed repo, not a database.

## Consequences

Concrete gaps to close after this model is accepted (each is follow-up work, not part of the ADR):

- **Grafana**: restrict its Pocket-ID client to `admin` (today any user could log in). Keep Grafana's
  role-mapping for privilege level.
- **Obsidian/vault**: verify how `vault.bretagne.dev` is authenticated — it has *no* OIDC client. Gate
  it (own client + oauth2-proxy, restricted to `admin`) or document why it's exempt.
- **Stremio**: explicit decision — stays public, or gets an `stremio` client + oauth2-proxy restricted
  to `stremio-users`.
- **Client config in Git**: implement option (b) or (a) per the confirmed decision.
- **Defense-in-depth** (optional): once the `groups` claim is verified, add `allowed_groups=admin` to
  the agent/code-server oauth2-proxies.

Until this is done, authz is *functional* (agent/code-server correctly gated, single admin user, no
self-registration) but **not uniformly enforced and not reviewable in Git**.
