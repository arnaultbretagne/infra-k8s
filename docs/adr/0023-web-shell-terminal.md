# ADR 0023 — Host web shell at terminal.bretagne.dev

## Status

**Accepted — 2026-07-03.** Live. Builds on [ADR 0021](0021-oauth2-proxy-oidc-gate.md)
(oauth2-proxy gate) and [ADR 0022](0022-oidc-authz-model.md) (OIDC authz model).

## Context

We want a browser-reachable terminal that gives the **same low-level host access as an operator
session** — `su - dev` on the node, with `dev`'s NOPASSWD sudo — not a shell confined to a
container's own namespaces. It must sit behind Pocket-ID, restricted to the `admin` group.

A pod-based terminal (ttyd in a container) is the obvious first thought but is the wrong tool: it
would expose the *pod's* filesystem/PID space, not the host's. Making a pod escape to the host
requires `hostPID` + `privileged` + `nsenter` — a node-owning pod that is more dangerous and more
fragile (image must ship a real `nsenter`) than simply running the shell on the host.

## Decision

Run the shell **on the host as systemd units**; the cluster owns only the edge glue.

- **`ttyd-terminal.service`** — `ttyd` bound to **`127.0.0.1:7681`**, exec'ing `/bin/su - dev`.
  Loopback-only ⇒ **no pod can reach it** (closes the "rogue pod → host root shell" pivot — relevant
  because the `agent` namespace runs Claude with bypass permissions).
- **`terminal-oauth2-proxy.service`** — host `oauth2-proxy` on `:4180`, upstream `127.0.0.1:7681`.
  The **only** exposed surface, and only to the **pod CIDR** (nftables `10.244.0.0/16 → 4180`). Runs
  the OIDC flow against Pocket-ID and enforces `--allowed-groups=admin`.
- **Cluster edge (`apps/terminal/`, GitOps)** — a selector-less `Service` + a manual `EndpointSlice`
  pointing at the node IP `:4180`, plus an `HTTPRoute` on the shared Gateway (`https-terminal`
  listener) with the standard HSTS filter. TLS is the usual cert-manager multi-SAN.

Request path: `browser → Traefik(:443) → Service/EndpointSlice → host oauth2-proxy(:4180) →
ttyd(127.0.0.1:7681) → su - dev`.

### Authorization — two enforced layers (per ADR 0022)

1. **Pocket-ID client `terminal`** is `isGroupRestricted: true`, allowed group `admin` — the IdP
   refuses to mint a token for a non-admin. Declared in `apps/pocket-id/oidc-reconciler/spec.json`
   (bijective — omission would prune it).
2. **oauth2-proxy** `--allowed-groups=admin` — re-checks the `groups` claim.

## Consequences

- **This is a host-root-equivalent shell on the public internet.** Its entire safety rests on the
  Pocket-ID `admin` gate + TLS. Acceptable because it is exactly the access model of an operator SSH
  session, deliberately scoped to `admin`, and no more powerful than the existing `code-server`.
- **Not fully GitOps** — the two host units are outside Kubernetes by nature. They are reproduced by
  `bootstrap/terminal-host/provision.sh` (idempotent); the OIDC secret is in SOPS
  (`bootstrap/terminal-host/oauth2-proxy.secret.yaml`); the firewall rule is in `bootstrap.sh`. The
  cluster edge is normal GitOps.
- **ttyd runs as root to `su - dev`.** A host-local process could reach `127.0.0.1:7681`, but the
  only local accounts are `root`/`dev`, which already have this access — no new escalation.
- **Single node, no HA**: if the node is down the terminal is down (so is everything else).
