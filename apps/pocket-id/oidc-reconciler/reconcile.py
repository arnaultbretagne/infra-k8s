#!/usr/bin/env python3
"""Reconcile Pocket-ID OIDC clients + user-groups from a versioned spec (ADR 0022).

Source of truth = /spec/spec.json (Git). This makes Pocket-ID's client policy
BIJECTIVE with the spec: anything in the spec is created/updated, anything not in
the spec is pruned. It manages *policy* (callback URLs, group restriction, groups)
and, for a client whose spec names a `secret` ({namespace, name}), its client
secret: minted in Pocket-ID, written to that Secret, the only one the client keeps
(ADR 0022). Never logs a secret. A client without `secret` keeps the old way: its
secret bootstrapped by hand into its app's SOPS.

MODE=dry-run (default): read-only, prints the plan, mutates nothing.
MODE=enforce: applies the plan.

Exit 2 = fatal/refused, 1 = ran with API errors, 0 = clean.
"""
import base64, json, os, ssl, sys, urllib.request, urllib.error

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

# The API server, for the Secrets the spec names: the Pod's ServiceAccount (KUBE_API and SA_DIR stand in
# for them in tests/pocket-id-reconciler).
SA_DIR = os.environ.get("SA_DIR", "/var/run/secrets/kubernetes.io/serviceaccount")
KUBE_API = os.environ.get("KUBE_API") or (
    f"https://{os.environ['KUBERNETES_SERVICE_HOST']}:{os.environ['KUBERNETES_SERVICE_PORT']}"
    if os.environ.get("KUBERNETES_SERVICE_HOST") else None)

def kube(method, path, body=None):
    if KUBE_API is None:
        return 0, {"error": "no API server"}
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(KUBE_API + path, data=data, method=method)
    try:
        with open(f"{SA_DIR}/token") as f:
            req.add_header("Authorization", "Bearer " + f.read().strip())
    except OSError as e:
        return 0, {"error": f"no ServiceAccount token: {e}"}
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    context = ssl.create_default_context(cafile=f"{SA_DIR}/ca.crt") if KUBE_API.startswith("https://") else None
    try:
        with urllib.request.urlopen(req, timeout=15, context=context) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode(errors="replace")[:200]}
    except Exception as e:
        return 0, {"error": str(e)}

def b64(text): return base64.b64encode(text.encode()).decode()
def unb64(text): return base64.b64decode(text or "").decode()

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

def group_restricted(client):
    # Listing groups restricts to them. A client may also be restricted to none (`isGroupRestricted`
    # with no group): then no user is allowed at all, as for a machine client nobody may sign in with.
    return bool(client.get("isGroupRestricted", bool(client.get("allowedGroups"))))

def group_ids_for(client):
    ids = []
    for gname in client.get("allowedGroups", []):
        if gname in gid: ids.append(gid[gname])
        else: log(f"         WARN {client['name']}: group '{gname}' not present yet")
    return ids

def ensure_secret(name, cid, where):
    """The client's secret, owned here: exactly one in Pocket-ID, the same one in the Secret `where` names.

    The Secret exists (its app creates it empty, `kustomize.toolkit.fluxcd.io/ssa: IfNotPresent`, and
    lets this ServiceAccount get and update it). Empty, or holding a secret Pocket-ID no longer has, a
    new one is minted and written there with its id; then every other secret of the client is deleted.
    Emptying the Secret rotates it. Values are never logged."""
    global changes, errors
    if not isinstance(where, dict) or not where.get("namespace") or not where.get("name"):
        log(f"[secret] ERROR   {name}: `secret` must give a namespace and a name"); errors += 1; return
    path = f"/api/v1/namespaces/{where['namespace']}/secrets/{where['name']}"
    shown = f"{where['namespace']}/{where['name']}"
    if cid is None:
        log(f"[secret] MINT    {name} -> {shown}  (new client)"); return
    st, current = kube("GET", path)
    if st != 200 or not isinstance(current, dict):
        log(f"[secret] ERROR   {name}: cannot read {shown} ({st}); its app creates it, empty"); errors += 1; return
    data = current.get("data") or {}
    try:
        held, held_id, held_client = unb64(data.get("client_secret")), unb64(data.get("secret_id")), unb64(data.get("client_id"))
    except Exception:
        held, held_id, held_client = "", "", ""
    st, listed = api("GET", f"/oidc/clients/{cid}/secrets")
    if st != 200 or not isinstance(listed, list):
        log(f"[secret] ERROR   {name}: cannot list its secrets ({st})"); errors += 1; return
    ids = [x["id"] for x in listed]
    keep = held_id if held and held_client == cid and held_id in ids else None
    if keep is None:
        reason = "empty" if not held else ("another client's" if held_client != cid else "not in Pocket-ID")
        log(f"[secret] MINT    {name} -> {shown}  ({reason})")
        if not ENFORCE:
            return
        st, created = api("POST", f"/oidc/clients/{cid}/secrets", {})
        if st not in (200, 201) or not isinstance(created, dict) or not created.get("secret") or not created.get("id"):
            log(f"         ERROR mint secret {name}: {st}"); errors += 1; return
        current["data"] = {**data, "client_id": b64(cid), "client_secret": b64(created["secret"]), "secret_id": b64(created["id"])}
        st, res = kube("PUT", path, current)
        if st != 200:
            # Unwritten, it would be a secret nobody holds: deleted again, the next run tries anew.
            log(f"         ERROR write {shown}: {st}; the new secret is deleted again")
            api("DELETE", f"/oidc/clients/{cid}/secrets/{created['id']}")
            errors += 1; return
        changes += 1
        keep = created["id"]
    for sid in ids:
        if sid == keep:
            continue
        log(f"[secret] DELETE  {name}  (a secret {shown} does not hold)")
        if ENFORCE:
            st, res = api("DELETE", f"/oidc/clients/{cid}/secrets/{sid}")
            if st in (200, 204): changes += 1
            else: log(f"         ERROR delete a secret of {name}: {st}"); errors += 1

for name, want in want_clients.items():
    cur = cur_clients.get(name)
    cid = None

    if cur is None:
        where = want.get("secret")
        log(f"[client] CREATE  {name}  (NEW — " + (f"its client_secret goes to {where['namespace']}/{where['name']})" if where else
            f"its client_secret must be bootstrapped into {name}'s SOPS by hand)"))
        body = {
            "name": name,
            "callbackURLs": want.get("callbackURLs", []),
            "logoutCallbackURLs": want.get("logoutCallbackURLs", []),
            "isPublic": want.get("isPublic", False),
            "pkceEnabled": want.get("pkceEnabled", False),
            "requiresReauthentication": want.get("requiresReauthentication", False),
            # Derived, never declared: listing groups == restricting to them. This is the
            # actual gate — without it Pocket-ID ignores allowedUserGroups and lets ANY user in.
            "isGroupRestricted": group_restricted(want),
        }
        # A client may pin its id: what its consumers list (a machine client's sub = client-<id>) is
        # then known before it exists, and recreating it keeps it. Pocket-ID mints one otherwise.
        if want.get("id"):
            body["id"] = want["id"]
        if want.get("accessTokenDurationMinutes"):
            body["accessTokenDurationMinutes"] = want["accessTokenDurationMinutes"]
        if ENFORCE:
            st, res = api("POST", "/oidc/clients", body)
            if st in (200, 201) and res:
                cid = res["id"]; changes += 1
                log(f"         created id={cid}" + ("" if want.get("secret") else f" — STORE its client_secret in {name}'s SOPS"))
            else:
                log(f"         ERROR create client {name}: {st} {res}"); errors += 1; continue
    else:
        cid = cur["id"]
        if want.get("id") and want["id"] != cid:
            # The id is fixed at creation: only deleting the client changes it, and that is for a human.
            # Nothing is written to a client that is not the one the spec pins: no update, no groups.
            log(f"[client] SKIP    {name}  (ERROR: id {cid} is not the spec's {want['id']}; nothing written)")
            errors += 1
            continue
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
        if detail.get("isGroupRestricted", False) != group_restricted(want):
            drift.append("isGroupRestricted")
        if want.get("accessTokenDurationMinutes") and detail.get("accessTokenDurationMinutes") != want["accessTokenDurationMinutes"]:
            drift.append("accessTokenDurationMinutes")
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
                    # Pocket-ID resets an update without it to 60 minutes: the spec's, else the current one.
                    "accessTokenDurationMinutes": want.get("accessTokenDurationMinutes") or detail.get("accessTokenDurationMinutes", 0),
                }
                body["isGroupRestricted"] = group_restricted(want)
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

    if want.get("secret"):
        ensure_secret(name, cid, want["secret"])

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
