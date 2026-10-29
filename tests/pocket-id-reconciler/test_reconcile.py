"""apps/pocket-id/oidc-reconciler/reconcile.py against a simulated Pocket-ID API: every write it would send.

Stdlib only, like the reconciler: `python3 -m unittest discover -s tests/pocket-id-reconciler -v`.
The script runs unchanged, with MODE=enforce and the repository's spec.json; urllib's urlopen is the only
thing replaced.
"""
import contextlib
import copy
import io
import json
import os
import pathlib
import unittest
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "apps/pocket-id/oidc-reconciler/reconcile.py"
SPEC_PATH = ROOT / "apps/pocket-id/oidc-reconciler/spec.json"
SPEC = json.loads(SPEC_PATH.read_text())
GATEWAY = "agora_gateway_vault"
GATEWAY_ID = next(c["id"] for c in SPEC["clients"] if c["name"] == GATEWAY)
GROUP_IDS = {g["name"]: f"group-{g['name']}" for g in SPEC["groups"]}


class Response(io.BytesIO):
    def __init__(self, status, body):
        super().__init__(json.dumps(body).encode() if body is not None else b"")
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class PocketID:
    """The part of Pocket-ID's API the reconciler uses, every client in the spec in sync to begin with."""

    def __init__(self):
        self.groups = [{"name": n, "id": i} for n, i in GROUP_IDS.items()]
        self.clients = {}
        for n, c in enumerate(SPEC["clients"]):
            cid = c.get("id", f"minted-{n}")
            self.clients[cid] = {
                "id": cid,
                "name": c["name"],
                "callbackURLs": list(c.get("callbackURLs", [])),
                "isPublic": c.get("isPublic", False),
                "pkceEnabled": c.get("pkceEnabled", False),
                "isGroupRestricted": bool(c.get("allowedGroups")),
                "allowedUserGroups": [{"id": GROUP_IDS[g]} for g in c.get("allowedGroups", [])],
                "accessTokenDurationMinutes": c.get("accessTokenDurationMinutes", 60),
            }
        self.writes = []

    def by_name(self, name):
        return next(c for c in self.clients.values() if c["name"] == name)

    def urlopen(self, req, timeout=None):
        method = req.get_method()
        path = req.full_url.split("/api", 1)[1]
        body = json.loads(req.data) if req.data else None
        if method == "GET" and path.startswith("/user-groups"):
            return Response(200, {"data": self.groups})
        if method == "GET" and path.startswith("/oidc/clients?"):
            return Response(200, {"data": [{"id": c["id"], "name": c["name"]} for c in self.clients.values()]})
        if method == "GET" and path.startswith("/oidc/clients/"):
            return Response(200, copy.deepcopy(self.clients[path.split("/")[3]]))
        self.writes.append((method, path, body))
        if method == "POST" and path == "/oidc/clients":
            cid = body.get("id") or "minted-new"
            self.clients[cid] = {**body, "id": cid, "allowedUserGroups": []}
            return Response(201, {"id": cid})
        return Response(200, {})


def run(api):
    env = {"POCKET_ID_URL": "http://pocket-id/api", "POCKET_ID_API_KEY": "test", "MODE": "enforce", "SPEC_PATH": str(SPEC_PATH)}
    saved_env, saved_urlopen = dict(os.environ), urllib.request.urlopen
    os.environ.update(env)
    urllib.request.urlopen = api.urlopen
    out = io.StringIO()
    code = 0
    try:
        with contextlib.redirect_stdout(out):
            exec(compile(SCRIPT.read_text(), str(SCRIPT), "exec"), {"__name__": "__main__"})
    except SystemExit as exit:
        code = exit.code
    finally:
        urllib.request.urlopen = saved_urlopen
        os.environ.clear()
        os.environ.update(saved_env)
    return code, out.getvalue()


class Reconcile(unittest.TestCase):
    def test_in_sync_writes_nothing(self):
        api = PocketID()
        code, log = run(api)
        self.assertEqual(api.writes, [], log)
        self.assertEqual(code, 0, log)

    def test_absent_gateway_client_is_created_with_its_pinned_id_and_token_duration(self):
        api = PocketID()
        del api.clients[GATEWAY_ID]
        code, log = run(api)
        self.assertEqual(code, 0, log)
        post = [w for w in api.writes if w[0] == "POST"]
        self.assertEqual(len(post), 1, log)
        self.assertEqual(post[0][2]["id"], GATEWAY_ID)
        self.assertEqual(post[0][2]["name"], GATEWAY)
        self.assertEqual(post[0][2]["accessTokenDurationMinutes"], 15)
        self.assertEqual(post[0][2]["callbackURLs"], [])
        self.assertIn(("PUT", f"/oidc/clients/{GATEWAY_ID}/allowed-user-groups", {"userGroupIds": [GROUP_IDS["admin"]]}), api.writes)

    def test_a_client_whose_id_diverges_receives_no_write_at_all(self):
        """R5: the name matches the spec, the id does not, and everything else drifts too."""
        api = PocketID()
        wrong = api.clients.pop(GATEWAY_ID)
        wrong.update(id="11111111-2222-4333-8444-555555555555", callbackURLs=["https://elsewhere.example/cb"], pkceEnabled=True,
                     isGroupRestricted=False, allowedUserGroups=[], accessTokenDurationMinutes=60)
        api.clients[wrong["id"]] = wrong
        code, log = run(api)
        self.assertEqual(api.writes, [], log)
        self.assertEqual(code, 1, log)
        self.assertIn(f"[client] SKIP    {GATEWAY}", log)
        self.assertIn("nothing written", log)

    def test_token_duration_drift_is_corrected(self):
        api = PocketID()
        api.clients[GATEWAY_ID]["accessTokenDurationMinutes"] = 60
        code, log = run(api)
        self.assertEqual(code, 0, log)
        self.assertEqual([(w[0], w[1]) for w in api.writes], [("PUT", f"/oidc/clients/{GATEWAY_ID}")], log)
        self.assertEqual(api.writes[0][2]["accessTokenDurationMinutes"], 15)

    def test_an_update_keeps_the_token_duration_of_a_client_whose_spec_does_not_set_it(self):
        """Pocket-ID resets an update without accessTokenDurationMinutes to 60 minutes."""
        api = PocketID()
        grafana = api.by_name("grafana")
        grafana.update(callbackURLs=["https://drift.example/cb"], accessTokenDurationMinutes=30)
        code, log = run(api)
        self.assertEqual(code, 0, log)
        put = [w for w in api.writes if w[1] == f"/oidc/clients/{grafana['id']}"]
        self.assertEqual(len(put), 1, log)
        self.assertEqual(put[0][2]["accessTokenDurationMinutes"], 30)
        self.assertEqual(put[0][2]["callbackURLs"], next(c["callbackURLs"] for c in SPEC["clients"] if c["name"] == "grafana"))


if __name__ == "__main__":
    unittest.main()
