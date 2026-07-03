#!/usr/bin/env python3
"""Reconcile Pocket-ID OIDC clients + user-groups from a versioned spec (ADR 0022).

Source of truth = /spec/spec.json (Git). This makes Pocket-ID's client policy
BIJECTIVE with the spec: anything in the spec is created/updated, anything not in
the spec is pruned. It manages *policy* only (callback URLs, group restriction,
groups) — it never touches client secrets.

MODE=dry-run (default): read-only, prints the plan, mutates nothing.
MODE=enforce: applies the plan.

Exit 2 = fatal/refused, 1 = ran with API errors, 0 = clean.
"""
import json, os, sys, urllib.request, urllib.error

BASE = os.environ["POCKET_ID_URL"].rstrip("/")
KEY = os.environ["POCKET_ID_API_KEY"]
MODE = os.environ.get("MODE", "dry-run").lower()
ENFORCE = MODE == "enforce"
SPEC_PATH = os.environ.get("SPEC_PATH", "/spec/spec.json")

changes = 0
errors = 0

def log(m): print(m, flush=True)
def die(m): log(f"FATAL: {m}"); sys.exit(2)

def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("X-API-Key", KEY)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode(errors="replace")}
    except Exception as e:
        return 0, {"error": str(e)}

def list_all(path):
    st, body = api("GET", path + "?pagination[limit]=1000")
    if st != 200:
        die(f"GET {path} failed ({st}): {body}")
    return body.get("data", []) if isinstance(body, dict) else (body or [])

# ---- load spec (with a hard guard against an empty spec pruning everything) ----
try:
    with open(SPEC_PATH) as f:
        spec = json.load(f)
except Exception as e:
    die(f"cannot read spec {SPEC_PATH}: {e}")

want_groups = {g["name"]: g for g in spec.get("groups", [])}
want_clients = {c["name"]: c for c in spec.get("clients", [])}
if not want_groups and not want_clients:
    die("spec lists no groups and no clients — refusing (would prune everything)")

log(f"=== OIDC reconciler | MODE={MODE} | {BASE} ===")
log(f"spec: {len(want_groups)} group(s), {len(want_clients)} client(s)")

# ---------------- GROUPS ----------------
cur_groups = {g["name"]: g for g in list_all("/user-groups")}
gid = {name: g["id"] for name, g in cur_groups.items()}

for name, g in want_groups.items():
    if name not in cur_groups:
        log(f"[group ] CREATE  {name}")
        if ENFORCE:
            st, res = api("POST", "/user-groups",
                          {"name": name, "friendlyName": g.get("friendlyName", name)})
            if st in (200, 201) and res: gid[name] = res["id"]; changes += 1
            else: log(f"         ERROR create group {name}: {st} {res}"); errors += 1

for name, g in cur_groups.items():
    if name not in want_groups:
        log(f"[group ] PRUNE   {name}  (not in spec)")
        if ENFORCE:
            st, res = api("DELETE", f"/user-groups/{g['id']}")
            if st in (200, 204): changes += 1
            else: log(f"         ERROR delete group {name}: {st} {res}"); errors += 1

# ---------------- CLIENTS ----------------
cur_clients = {c["name"]: c for c in list_all("/oidc/clients")}

def group_ids_for(client):
    ids = []
    for gname in client.get("allowedGroups", []):
        if gname in gid: ids.append(gid[gname])
        else: log(f"         WARN {client['name']}: group '{gname}' not present yet")
    return ids

for name, want in want_clients.items():
    cur = cur_clients.get(name)
    cid = None

    if cur is None:
        log(f"[client] CREATE  {name}  (NEW — its client_secret must be bootstrapped "
            f"into {name}'s SOPS by hand; the reconciler never writes secrets)")
        body = {
            "name": name,
            "callbackURLs": want.get("callbackURLs", []),
            "logoutCallbackURLs": want.get("logoutCallbackURLs", []),
            "isPublic": want.get("isPublic", False),
            "pkceEnabled": want.get("pkceEnabled", False),
            "requiresReauthentication": want.get("requiresReauthentication", False),
            # Derived, never declared: listing groups == restricting to them. This is the
            # actual gate — without it Pocket-ID ignores allowedUserGroups and lets ANY user in.
            "isGroupRestricted": bool(want.get("allowedGroups")),
        }
        if ENFORCE:
            st, res = api("POST", "/oidc/clients", body)
            if st in (200, 201) and res:
                cid = res["id"]; changes += 1
                log(f"         created id={cid} — STORE its client_secret in {name}'s SOPS")
            else:
                log(f"         ERROR create client {name}: {st} {res}"); errors += 1; continue
    else:
        cid = cur["id"]
        st, detail = api("GET", f"/oidc/clients/{cid}")
        if st != 200 or not detail:
            log(f"         ERROR get client {name}: {st} {detail}"); errors += 1; continue
        # Only touch fields we manage; preserve the rest (logout URLs, reauth).
        drift = []
        if sorted(detail.get("callbackURLs", [])) != sorted(want.get("callbackURLs", [])):
            drift.append("callbackURLs")
        if detail.get("isPublic", False) != want.get("isPublic", False):
            drift.append("isPublic")
        if detail.get("pkceEnabled", False) != want.get("pkceEnabled", False):
            drift.append("pkceEnabled")
        if detail.get("isGroupRestricted", False) != bool(want.get("allowedGroups")):
            drift.append("isGroupRestricted")
        if drift:
            log(f"[client] UPDATE  {name}  (drift: {', '.join(drift)})")
            if ENFORCE:
                body = {
                    "name": name,
                    "callbackURLs": want.get("callbackURLs", []),
                    "logoutCallbackURLs": detail.get("logoutCallbackURLs", []),
                    "isPublic": want.get("isPublic", False),
                    "pkceEnabled": want.get("pkceEnabled", False),
                    "requiresReauthentication": detail.get("requiresReauthentication", False),
                    "isGroupRestricted": bool(want.get("allowedGroups")),
                }
                st, res = api("PUT", f"/oidc/clients/{cid}", body)
                if st == 200: changes += 1
                else: log(f"         ERROR update client {name}: {st} {res}"); errors += 1

    # allowed groups (the actual authz filter)
    want_gids = sorted(group_ids_for(want))
    if cur is not None:
        cur_gids = sorted(g["id"] for g in (detail.get("allowedUserGroups") or []))
    else:
        cur_gids = []
    if want_gids != cur_gids:
        shown = want.get("allowedGroups", [])
        log(f"[client] GROUPS  {name} -> {shown}  (was {len(cur_gids)} group(s))")
        if ENFORCE and cid:
            st, res = api("PUT", f"/oidc/clients/{cid}/allowed-user-groups",
                          {"userGroupIds": want_gids})
            if st in (200, 204): changes += 1
            else: log(f"         ERROR set-groups {name}: {st} {res}"); errors += 1

for name, c in cur_clients.items():
    if name not in want_clients:
        log(f"[client] PRUNE   {name}  (not in spec)")
        if ENFORCE:
            st, res = api("DELETE", f"/oidc/clients/{c['id']}")
            if st in (200, 204): changes += 1
            else: log(f"         ERROR delete client {name}: {st} {res}"); errors += 1

log(f"=== done | changes={changes} errors={errors} mode={MODE} ===")
if not ENFORCE and changes:
    log("DRY-RUN — nothing applied. Set MODE=enforce to apply.")
sys.exit(1 if errors else 0)
