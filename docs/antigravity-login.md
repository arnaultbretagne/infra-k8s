# The cluster's Google login, for agy (Antigravity)

Agora's `antigravity` harness runs agy, Google's Antigravity CLI, on the cluster's own Google login
(docs/specs/credentials.md on arnaultbretagne/agora, "Antigravity"). This page is the operator's runbook: the
login, where its refresh token goes, how to tell it works, how to rotate or revoke it.

| Piece | Where |
| --- | --- |
| The pool | `apps/agora-sandboxes/catalogue/antigravity/`: image `agora-harness-antigravity`, base profile `antigravity`, a placeholder token file, no credential. |
| The routes | `apps/agora-gateway/config/config.yaml`, `antigravity` (`daily-cloudcode-pa.googleapis.com`, `/v1internal:<method>`) and `antigravity-userinfo` (`GET www.googleapis.com/oauth2/v2/userinfo` exactly): `Authorization: Bearer` + `/etc/agentgateway/antigravity/login/access_token`. No route for `oauth2.googleapis.com` nor `play.googleapis.com`. |
| The access token | The Secret `antigravity-token`, key `access_token`. Flux creates it empty; `antigravity-refresher` fills it every 15 minutes; the gateway mounts it (optional) and watches it, through the link its init container `antigravity-login` makes to the Secret's directory. agentgateway 1.6.0 does not start when a credential file is missing: if the Secret is absent when the gateway starts, `antigravity-login` puts a directory with an empty file in its place, so every other route answers as before and agy's answer 401 until the gateway restarts with the Secret back (`kubectl -n agora-gateway rollout restart deployment/gateway`). To cut the token, empty it rather than delete it: emptied, the next request carries no token, with no restart. |
| The refresh token | `antigravity-session` (out of git) **or** `upstream-credentials`, key `antigravity-refresh-token` (SOPS): below. Read by `antigravity-refresher` only. |
| The OAuth client | agy's own, public, in `apps/agora-gateway/antigravity-refresher.yaml` (`CLIENT_ID`, `CLIENT_SECRET`). |

## The account

A Google account **dedicated to the cluster**, holding its own Google AI subscription — never the operator's
own account or session. Its access token reaches that account's whole Google Cloud (scope `cloud-platform`):
the account owns no Cloud project, and holds nothing else.

## The login

Once, by the operator, with the official agy binary (1.5.13, the one the image ships), in a throwaway Linux
environment **with no D-Bus session bus**, so that agy writes its token to a file rather than a keyring:

```sh
export HOME=$(mktemp -d); unset DBUS_SESSION_BUS_ADDRESS
agy acp --login
# agy prints a URL: open it in a browser signed into the dedicated account, paste the code back.
node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME + "/.gemini/antigravity-cli/antigravity-oauth-token")).token.refresh_token)' > "$HOME/refresh_token"
```

`$HOME/refresh_token` is the refresh token (it starts with `1//`). Each login mints a new one. Delete the
throwaway HOME once the token is stored (below): `rm -rf "$HOME"`.

## Where the refresh token goes

It depends on one measurement: whether Google **rotates** the refresh token, that is, whether a refresh
answers a new `refresh_token` and the previous one stops working. Google documents that it does not; this has
not been seen with a real login yet. The refresher reads both places. **Nothing changes in the manifests**: only
where the operator puts the value, and `antigravity-session` wins when it exists.

**First, whatever the outcome: `antigravity-session`.** It is safe in both cases, and the refresher measures:

```sh
kubectl -n agora-gateway create secret generic antigravity-session --from-file=refresh_token="$HOME/refresh_token"
kubectl -n agora-gateway create job --from=cronjob/antigravity-refresher antigravity-refresher-first
kubectl -n agora-gateway logs -f job/antigravity-refresher-first
# refreshed (antigravity-session): access token valid until 2026-…Z (3599 s), refresh token unchanged
```

Leave it a few runs (every 15 minutes, at :07, :22, :37 and :52). Each run's log says `refresh token unchanged`
or `refresh token rotated`.

| Outcome | What goes where |
| --- | --- |
| **It rotates** (`rotated` in a log) | Stay as you are: the refresh token lives in the Secret `antigravity-session`, key `refresh_token`, created by hand, out of git; the refresher rewrites it with each new one, as `chatgpt-session`. Never put it in git: Flux would restore a spent token. |
| **It does not rotate** (`unchanged` on every run, for a day) | Move it to SOPS, then delete the Secret: `sops apps/agora-gateway/upstream-credentials.secrets.yaml`, add under `stringData` the line `antigravity-refresh-token: 1//…` (the same value), commit, merge; once Flux has applied it, `kubectl -n agora-gateway delete secret antigravity-session`. The next run logs `refreshed (upstream-credentials): …`. A rotation is then a commit. Note that the gateway mounts the whole of `upstream-credentials`, so it then holds the refresh token too, as it holds the other upstream credentials. |

If the token is in SOPS and Google rotates it all the same, the run still writes the access token, exits 3
and says `the login rotates — move it to antigravity-session`: do so with the newest login.

## How to tell it works

- `kubectl -n agora-gateway get cronjob antigravity-refresher`: a recent `LAST SCHEDULE`; the last Job
  `Complete`. Its log: `refreshed (…): access token valid until …`.
- A failed run fails its Job, which `CronJobLastRunFailed` reports like the other refreshers. The log says why:

| Exit | Log | Do |
| --- | --- | --- |
| 1 | `refresh refused (…): 400 invalid_grant: …` | The login was revoked, expired (six months unused) or superseded: log in again, replace the token. |
| 1 | `refresh failed (…): Google's token endpoint unreachable` | Network: the policy `antigravity-refresher` (DNS, the API server and 443 out, as `claude-refresher`), or Google. The access token lives an hour: two more runs before it lapses. |
| 2 | `reading/writing antigravity-…: <status>` | The API server or the RBAC. `refreshed, but the new refresh token was not written` is the one case where the login may be lost: log in again. |
| 3 | `the login rotates — …` or `the access token lives … s` | Written all the same; follow the message. |
| 4 | `no refresh token yet` / `CLIENT_ID or CLIENT_SECRET is empty` | The login is not done, or the client is missing. Until then agy's turns end on Google's 401; nothing else is affected. |

- End to end: an execution on the `antigravity` pool answers a turn. Through the gateway, with
  `antigravity`: `POST https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` and
  `GET https://www.googleapis.com/oauth2/v2/userinfo` answer 200 (the account's tier, its email); any other
  path, `oauth2.googleapis.com` and `play.googleapis.com` answer 403 from the gateway.

## Rotate, revoke

Google's revocation is **grant-wide**: revoking the login — from the account's permissions page, or by sending any
one of its tokens to `https://oauth2.googleapis.com/revoke` — ends the account's authorization of agy's client and
invalidates every access and refresh token issued under it, including one from a login made just before. So
never revoke after installing a new login: that would kill the new one too.

- **Rotate** (replace the refresh token, nothing compromised): log in again as above — a new login is a new refresh
  token under the same grant — and replace the value where it lives: `kubectl -n agora-gateway create secret generic antigravity-session --from-file=refresh_token="$HOME/refresh_token" --dry-run=client -o yaml | kubectl replace -f -`,
  or a commit of the SOPS key. Run the job once (`kubectl -n agora-gateway create job --from=cronjob/antigravity-refresher antigravity-refresher-rotate`)
  and check its log. **Do not revoke the old token**: it stops being used, and Google drops it on its own (six months
  unused, or past 100 refresh tokens of this client for the account).
- **Revoke** (the login is compromised, or the cluster must lose Google): revoke first, then, if agy must keep
  working, log in afresh and install the new token.
  1. Revoke the grant: in the dedicated account, <https://myaccount.google.com/permissions>, remove access for
     Antigravity (or `curl -d token=<refresh token> https://oauth2.googleapis.com/revoke`: the same grant-wide effect).
     Every token dies; the next run logs `refresh refused (…): 400 invalid_grant`.
  2. Cut what the gateway still holds (an access token can outlive the revocation until its expiry, at most an hour):
     `kubectl -n agora-gateway patch secret antigravity-token -p '{"data":{"access_token":""}}'` — the gateway sees it
     within about a minute, with no restart; and stop the job: `kubectl -n agora-gateway patch cronjob antigravity-refresher -p '{"spec":{"suspend":true}}'`
     (the manifest does not set `suspend`, so Flux leaves it).
  3. To resume: a fresh login (above) **after** the revocation, its refresh token installed where it lives, the job
     unsuspended (`… -p '{"spec":{"suspend":false}}'`) and run once, its log checked.
- **Withdraw the harness**: take `antigravity` out of `OFFERED_PROFILES` (`apps/agora/server.yaml`) and the
  folder out of `apps/agora-sandboxes/catalogue/kustomization.yaml`; the routes without a token answer 401.
