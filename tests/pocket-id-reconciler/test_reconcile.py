"""apps/pocket-id/oidc-reconciler/reconcile.py against a simulated Pocket-ID and a simulated API server.

Stdlib only, like the reconciler: `python3 -m unittest discover -s tests/pocket-id-reconciler -v`. The script
runs unchanged, with MODE=enforce (or dry-run) and a spec of the test's own; urllib's urlopen is the only thing
replaced. Every write either API receives is recorded.
"""
import base64
import contextlib
import copy
import io
import json
import os
import pathlib
import tempfile
import unittest
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "apps/pocket-id/oidc-reconciler/reconcile.py"
POCKET_ID = "http://pocket-id.test/api"
KUBE = "http://kube.test"
MACHINE, MACHINE_ID = "machine", "7d54f86c-7456-4cbd-b79d-a9bb7452bb62"
WEB = "web"
SECRET_PATH = "/api/v1/namespaces/app/secrets/machine-client"
SPEC = {
    "groups": [{"name": "admin", "friendlyName": "Admins"}],
    "clients": [
        {"name": WEB, "callbackURLs": ["https://web.example/cb"], "allowedGroups": ["admin"], "pkceEnabled": False},
        {"name": MACHINE, "id": MACHINE_ID, "accessTokenDurationMinutes": 15, "callbackURLs": [], "allowedGroups": [],
         "isGroupRestricted": True, "pkceEnabled": False, "secret": {"namespace": "app", "name": "machine-client"}},
    ],
}


def b64(text):
    return base64.b64encode(text.encode()).decode()


def unb64(text):
    return base64.b64decode(text).decode()


class Response(io.BytesIO):
    def __init__(self, status, body):
        super().__init__(json.dumps(body).encode() if body is not None else b"")
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class World:
    """Pocket-ID's API and the API server, as far as the reconciler reaches them; both clients in sync."""

    def __init__(self, spec=SPEC):
        self.groups = [{"name": "admin", "id": "group-admin"}]
        self.clients = {}
        for n, c in enumerate(spec["clients"]):
            cid = c.get("id", f"minted-{n}")
            self.clients[cid] = {
                "id": cid, "name": c["name"], "callbackURLs": list(c.get("callbackURLs", [])), "isPublic": False,
                "pkceEnabled": c.get("pkceEnabled", False), "isGroupRestricted": bool(c.get("isGroupRestricted", bool(c.get("allowedGroups")))),
                "allowedUserGroups": [{"id": "group-admin"} for _ in c.get("allowedGroups", [])],
                "accessTokenDurationMinutes": c.get("accessTokenDurationMinutes", 60),
            }
        self.secrets = {cid: [] for cid in self.clients}
        self.minted = 0
        self.kube_secret = {"metadata": {"name": "machine-client", "namespace": "app"}, "data": {"kept": b64("other key")}}
        self.kube_status = {"GET": 200, "PUT": 200}
        self.writes = []
        self.kube_writes = []

    def hold(self, secret_id, value="held-value", client=MACHINE_ID):
        """The Secret already holding a secret, and Pocket-ID knowing it."""
        self.kube_secret["data"].update(client_id=b64(client), client_secret=b64(value), secret_id=b64(secret_id))
        self.secrets.setdefault(client, []).append({"id": secret_id, "prefix": value[:4], "isActive": True})

    def urlopen(self, req, timeout=None, context=None):
        method, url = req.get_method(), req.full_url
        body = json.loads(req.data) if req.data else None
        if url.startswith(KUBE):
            path = url[len(KUBE):]
            assert req.get_header("Authorization") == "Bearer the-sa-token", req.get_header("Authorization")
            if path != SECRET_PATH:
                return Response(404, {"error": "not found"})
            if method != "GET":
                self.kube_writes.append((method, copy.deepcopy(body)))
            status = self.kube_status[method]
            if status != 200:
                raise urllib.error.HTTPError(url, status, "refused", {}, io.BytesIO(b'{"reason":"Forbidden"}'))
            if method == "PUT":
                self.kube_secret = body
            return Response(200, copy.deepcopy(self.kube_secret))
        path = url[len(POCKET_ID):]
        if method == "GET" and path.startswith("/user-groups"):
            return Response(200, {"data": self.groups})
        if method == "GET" and path.startswith("/oidc/clients?"):
            return Response(200, {"data": [{"id": c["id"], "name": c["name"]} for c in self.clients.values()]})
        if method == "GET" and path.endswith("/secrets"):
            return Response(200, copy.deepcopy(self.secrets[path.split("/")[3]]))
        if method == "GET" and path.startswith("/oidc/clients/"):
            return Response(200, copy.deepcopy(self.clients[path.split("/")[3]]))
        self.writes.append((method, path, body))
        if method == "POST" and path == "/oidc/clients":
            cid = body.get("id") or "minted-new"
            self.clients[cid] = {**body, "id": cid, "allowedUserGroups": []}
            self.secrets[cid] = [{"id": "auto-created", "prefix": "auto", "isActive": True}]
            return Response(201, {"id": cid})
        if method == "POST" and path.endswith("/secrets"):
            self.minted += 1
            sid = f"secret-{self.minted}"
            self.secrets[path.split("/")[3]].append({"id": sid, "prefix": "mint", "isActive": True})
            return Response(201, {"id": sid, "prefix": "mint", "isActive": True, "secret": f"the-minted-value-{self.minted}"})
        if method == "DELETE" and "/secrets/" in path:
            cid, sid = path.split("/")[3], path.split("/")[5]
            self.secrets[cid] = [s for s in self.secrets[cid] if s["id"] != sid]
            return Response(204, None)
        return Response(200, {})


def run(world, spec=SPEC, mode="enforce"):
    with tempfile.TemporaryDirectory() as tmp:
        spec_path = pathlib.Path(tmp, "spec.json")
        spec_path.write_text(json.dumps(spec))
        pathlib.Path(tmp, "token").write_text("the-sa-token\n")
        env = {"POCKET_ID_URL": POCKET_ID, "POCKET_ID_API_KEY": "test", "MODE": mode, "SPEC_PATH": str(spec_path),
               "KUBE_API": KUBE, "SA_DIR": tmp}
        saved_env, saved_urlopen = dict(os.environ), urllib.request.urlopen
        os.environ.update(env)
        urllib.request.urlopen = world.urlopen
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


class ClientSecrets(unittest.TestCase):
    def test_an_empty_secret_gets_one_minted_written_with_its_id_and_the_others_deleted(self):
        w = World()
        w.secrets[MACHINE_ID].append({"id": "stray", "prefix": "old", "isActive": True})
        code, log = run(w)
        self.assertEqual(code, 0, log)
        data = w.kube_secret["data"]
        self.assertEqual(unb64(data["client_secret"]), "the-minted-value-1")
        self.assertEqual(unb64(data["secret_id"]), "secret-1")
        self.assertEqual(unb64(data["client_id"]), MACHINE_ID)
        self.assertEqual(unb64(data["kept"]), "other key")
        self.assertEqual([s["id"] for s in w.secrets[MACHINE_ID]], ["secret-1"])
        self.assertIn(("DELETE", f"/oidc/clients/{MACHINE_ID}/secrets/stray", None), w.writes)
        self.assertNotIn("the-minted-value", log)

    def test_a_held_secret_pocket_id_knows_is_kept_and_nothing_is_written(self):
        w = World()
        w.hold("held")
        code, log = run(w)
        self.assertEqual(code, 0, log)
        self.assertEqual(w.writes, [], log)
        self.assertEqual(w.kube_writes, [], log)
        self.assertNotIn("held-value", log)

    def test_a_held_secret_kept_and_a_second_one_in_pocket_id_deleted(self):
        w = World()
        w.hold("held")
        w.secrets[MACHINE_ID].append({"id": "made-by-hand", "prefix": "hand", "isActive": True})
        code, log = run(w)
        self.assertEqual(code, 0, log)
        self.assertEqual(w.writes, [("DELETE", f"/oidc/clients/{MACHINE_ID}/secrets/made-by-hand", None)], log)
        self.assertEqual(w.kube_writes, [], log)

    def test_a_held_secret_pocket_id_no_longer_has_is_replaced(self):
        w = World()
        w.hold("gone")
        w.secrets[MACHINE_ID] = []
        code, log = run(w)
        self.assertEqual(code, 0, log)
        self.assertEqual(unb64(w.kube_secret["data"]["secret_id"]), "secret-1")
        self.assertIn("not in Pocket-ID", log)

    def test_a_secret_of_another_client_is_replaced(self):
        w = World()
        w.hold("held", client="someone-else")
        w.secrets[MACHINE_ID] = []
        code, log = run(w)
        self.assertEqual(code, 0, log)
        self.assertEqual(unb64(w.kube_secret["data"]["client_id"]), MACHINE_ID)
        self.assertIn("another client's", log)

    def test_a_secret_it_cannot_write_is_deleted_again(self):
        w = World()
        w.kube_status["PUT"] = 403
        code, log = run(w)
        self.assertEqual(code, 1, log)
        self.assertEqual(w.secrets[MACHINE_ID], [], log)
        self.assertIn(("DELETE", f"/oidc/clients/{MACHINE_ID}/secrets/secret-1", None), w.writes)
        self.assertNotIn("the-minted-value", log)

    def test_a_secret_its_app_has_not_created_mints_nothing(self):
        w = World()
        w.kube_status["GET"] = 404
        code, log = run(w)
        self.assertEqual(code, 1, log)
        self.assertEqual(w.minted, 0, log)
        self.assertIn("cannot read app/machine-client (404)", log)

    def test_a_new_client_is_created_and_its_secret_written_in_the_same_run(self):
        w = World()
        del w.clients[MACHINE_ID]
        code, log = run(w)
        self.assertEqual(code, 0, log)
        self.assertEqual(w.writes[0][2]["id"], MACHINE_ID)
        self.assertEqual(unb64(w.kube_secret["data"]["client_secret"]), "the-minted-value-1")
        # The secret Pocket-ID may create along with the client is not the one held: deleted.
        self.assertEqual([s["id"] for s in w.secrets[MACHINE_ID]], ["secret-1"])
        self.assertIn("its client_secret goes to app/machine-client", log)

    def test_dry_run_says_what_it_would_mint_and_writes_nothing(self):
        w = World()
        code, log = run(w, mode="dry-run")
        self.assertEqual(code, 0, log)
        self.assertEqual((w.writes, w.kube_writes, w.minted), ([], [], 0), log)
        self.assertIn("[secret] MINT    machine -> app/machine-client  (empty)", log)

    def test_a_client_without_secret_never_reaches_its_secrets_nor_the_api_server(self):
        spec = {**SPEC, "clients": [SPEC["clients"][0]]}
        w = World(spec)
        w.kube_status["GET"] = 500
        code, log = run(w, spec)
        self.assertEqual(code, 0, log)
        self.assertEqual((w.writes, w.kube_writes), ([], []), log)

    def test_a_secret_without_a_namespace_and_a_name_is_an_error(self):
        spec = {**SPEC, "clients": [SPEC["clients"][0], {**SPEC["clients"][1], "secret": {"name": "x"}}]}
        w = World(spec)
        code, log = run(w, spec)
        self.assertEqual(code, 1, log)
        self.assertIn("`secret` must give a namespace and a name", log)


class ClientPolicy(unittest.TestCase):
    def test_a_new_client_takes_its_pinned_id_token_duration_and_restriction_to_no_group(self):
        w = World()
        del w.clients[MACHINE_ID]
        w.hold("unused")
        code, log = run(w)
        self.assertEqual(code, 0, log)
        post = w.writes[0]
        self.assertEqual((post[0], post[1]), ("POST", "/oidc/clients"))
        self.assertEqual((post[2]["id"], post[2]["accessTokenDurationMinutes"], post[2]["isGroupRestricted"]), (MACHINE_ID, 15, True))

    def test_a_client_whose_id_diverges_receives_no_write_at_all(self):
        w = World()
        wrong = w.clients.pop(MACHINE_ID)
        wrong.update(id="11111111-2222-4333-8444-555555555555", accessTokenDurationMinutes=60)
        w.clients[wrong["id"]] = wrong
        w.secrets[wrong["id"]] = []
        code, log = run(w)
        self.assertEqual(code, 1, log)
        self.assertEqual((w.writes, w.kube_writes), ([], []), log)
        self.assertIn(f"[client] SKIP    {MACHINE}", log)

    def test_token_duration_drift_is_corrected_and_kept_on_update(self):
        w = World()
        w.hold("held")
        w.clients[MACHINE_ID]["accessTokenDurationMinutes"] = 60
        code, log = run(w)
        self.assertEqual(code, 0, log)
        self.assertEqual([(m, p) for m, p, _ in w.writes], [("PUT", f"/oidc/clients/{MACHINE_ID}")], log)
        self.assertEqual(w.writes[0][2]["accessTokenDurationMinutes"], 15)
        self.assertTrue(w.writes[0][2]["isGroupRestricted"])

    def test_an_update_keeps_the_token_duration_of_a_client_whose_spec_does_not_set_it(self):
        """Pocket-ID resets an update without accessTokenDurationMinutes to 60 minutes."""
        w = World()
        w.hold("held")
        w.clients["minted-0"].update(accessTokenDurationMinutes=30, pkceEnabled=True)
        code, log = run(w)
        self.assertEqual(code, 0, log)
        self.assertEqual(w.writes[0][2]["accessTokenDurationMinutes"], 30)


if __name__ == "__main__":
    unittest.main()
