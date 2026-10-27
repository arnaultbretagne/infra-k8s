"""reconcile.py and the previews' machine client, `agora_gateway_previews`, against a simulated Pocket-ID API.

Stdlib only, like the reconciler: `python3 -m unittest discover -s tests/pocket-id-reconciler -v`. The script runs
unchanged, with MODE=enforce and the repository's spec.json; urllib's urlopen is the only thing replaced, and every
write it would send is recorded.
"""
import contextlib
import copy
import io
import json
import os
import pathlib
import unittest
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "apps/pocket-id/oidc-reconciler/reconcile.py"
SPEC_PATH = ROOT / "apps/pocket-id/oidc-reconciler/spec.json"
SPEC = json.loads(SPEC_PATH.read_text())
NAME = "agora_gateway_previews"
CLIENT = next(c for c in SPEC["clients"] if c["name"] == NAME)
GROUP_IDS = {g["name"]: f"group-{g['name']}" for g in SPEC["groups"]}


def restricted(c):
    return bool(c.get("isGroupRestricted", bool(c.get("allowedGroups"))))


class Response(io.BytesIO):
    def __init__(self, status, body):
        super().__init__(json.dumps(body).encode() if body is not None else b"")
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class PocketID:
    """The part of Pocket-ID's API the reconciler uses, every client of the spec in sync to begin with."""

    def __init__(self):
        self.groups = [{"name": n, "id": i} for n, i in GROUP_IDS.items()]
        self.clients = {}
        for n, c in enumerate(SPEC["clients"]):
            cid = c.get("id", f"minted-{n}")
            self.clients[cid] = {
                "id": cid, "name": c["name"], "callbackURLs": list(c.get("callbackURLs", [])),
                "isPublic": c.get("isPublic", False), "pkceEnabled": c.get("pkceEnabled", False),
                "isGroupRestricted": restricted(c),
                "allowedUserGroups": [{"id": GROUP_IDS[g]} for g in c.get("allowedGroups", [])],
                "accessTokenDurationMinutes": c.get("accessTokenDurationMinutes", 60),
            }
        self.writes = []

    def urlopen(self, req, timeout=None):
        method, path = req.get_method(), req.full_url.split("/api", 1)[1]
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
    out, code = io.StringIO(), 0
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


class PreviewsClient(unittest.TestCase):
    def test_the_spec_declares_a_machine_client_restricted_to_no_group(self):
        self.assertEqual(CLIENT["callbackURLs"], [])
        self.assertEqual(CLIENT["allowedGroups"], [])
        self.assertIs(CLIENT["isGroupRestricted"], True)
        self.assertEqual(CLIENT["accessTokenDurationMinutes"], 15)

    def test_in_sync_writes_nothing(self):
        api = PocketID()
        code, log = run(api)
        self.assertEqual(api.writes, [], log)
        self.assertEqual(code, 0, log)

    def test_absent_it_is_created_restricted_to_no_group_with_its_id_and_15_minute_tokens(self):
        api = PocketID()
        del api.clients[CLIENT["id"]]
        code, log = run(api)
        self.assertEqual(code, 0, log)
        posts = [w for w in api.writes if w[0] == "POST"]
        self.assertEqual(len(posts), 1, log)
        body = posts[0][2]
        self.assertEqual((body["id"], body["name"], body["isGroupRestricted"], body["accessTokenDurationMinutes"], body["callbackURLs"]), (CLIENT["id"], NAME, True, 15, []))
        self.assertEqual([w for w in api.writes if w[1].endswith("/allowed-user-groups")], [], "no group given to it")

    def test_unrestricted_it_is_restricted_again(self):
        api = PocketID()
        api.clients[CLIENT["id"]]["isGroupRestricted"] = False
        code, log = run(api)
        self.assertEqual(code, 0, log)
        self.assertEqual([(w[0], w[1]) for w in api.writes], [("PUT", f"/oidc/clients/{CLIENT['id']}")], log)
        self.assertIs(api.writes[0][2]["isGroupRestricted"], True)
        self.assertEqual(api.writes[0][2]["accessTokenDurationMinutes"], 15)

    def test_a_client_with_groups_stays_restricted_to_them(self):
        api = PocketID()
        grafana = next(c for c in api.clients.values() if c["name"] == "grafana")
        grafana["callbackURLs"] = ["https://drift.example/cb"]
        code, log = run(api)
        self.assertEqual(code, 0, log)
        put = [w for w in api.writes if w[1] == f"/oidc/clients/{grafana['id']}"]
        self.assertEqual(len(put), 1, log)
        self.assertIs(put[0][2]["isGroupRestricted"], True)


if __name__ == "__main__":
    unittest.main()
