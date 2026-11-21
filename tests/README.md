# tests

Tests of what this repository deploys, one folder each. The `tests` workflow
(`.github/workflows/tests.yml`) runs every folder that holds a `ci.paths` file: on a pull request
or a push to `main`, those whose paths changed; by hand (workflow_dispatch), all of them.

## Adding a test

A test is a folder, never a workflow. The GitHub App agents push with has no `workflows`
permission, and the runner is what keeps a branch's tests away from this repository's secrets.

| File | Role |
|---|---|
| `tests/<name>/ci.paths` | One pattern per line, from the repository's root; `#` starts a comment. A pattern matches as a bash pattern, `*` crossing `/` (`apps/obsidian/*` covers the whole folder). The test's own folder always counts. |
| `tests/<name>/ci.sh` | Optional. What the run does, in bash, from the test's folder. Without it, the run is `npm ci` then `npm test`. |
| `tests/<name>/README.md` | What the test proves and how to run it by hand. |

The run has: `ubuntu-24.04`, Node 24, Docker, kubectl v1.37.1 on `PATH` (checked against its
sha256), 20 minutes, a token that reads this repository and no secret. A tool beyond that is
fetched by `ci.sh` at a pinned version, checked against its sha256 (`flux-alerts/ci.sh`). The
test's output goes to the run's summary: its `✔`/`✖`/`ℹ` lines (`node --test`), else its last
30 lines.

A test that needs more than this — a secret, a schedule, a permission, another runner — is a
question for the operator, not a workflow to leave in a branch.

The `agora-gateway*` and `pocket-id-reconciler` workflows predate the runner and keep their own
files.
