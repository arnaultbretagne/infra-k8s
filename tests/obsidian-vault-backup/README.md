# obsidian-vault-backup: the vault backup's own script, run as deployed

The proof that the Obsidian vault backup (`apps/obsidian/vault-backup.yaml`) does what it says, run by the
`tests` workflow (`ci.sh`, `ci.paths`; `tests/README.md`) on every pull request touching `apps/obsidian`:

- **What runs:** `kubectl kustomize apps/obsidian`, as Flux applies it. The script is the rendered ConfigMap
  `obsidian-vault-backup-scripts`; each run takes a CronJob's (or `apps/obsidian/backup/restore-job.yaml`'s)
  image, command, environment (`envFrom` resolved from the render) and mounts. `obsidian-data` is a
  directory with its `vault/` subPath, read-only where the manifest says so.
- **Where:** `docker run` of the manifests' `rclone/rclone` image (the one `ha-config-backup` uses), its root
  read-only, no capability, no privilege escalation, no network, as the caller's uid (the pod runs 1000; the
  script does not depend on it). `RUNNER=local` instead runs `sh` and `rclone` from `PATH`, after checking
  that `rclone version` is the manifests' version.
- **The one change:** the `r2` remote is rclone's `local` backend instead of `s3`
  (`RCLONE_CONFIG_R2_TYPE=local`), a directory standing for the bucket. The crypt remote `backup` over it
  is the real one.
- **Secrets:** none real. The Secret's keys are the SOPS file's, with made-up values.

| Case | Expected |
| --- | --- |
| The manifests | Image = `ha-config-backup`'s; backup every 15 min, verify weekly, both `Forbid`; the PVC `obsidian-data`, subPath `vault`, read-only; the pod security of the criteria; the Secret SOPS-encrypted for `.sops.yaml`'s recipient, nothing in clear; the network policy: DNS, and 443 to `*.r2.cloudflarestorage.com` only, nothing in. |
| (a) A second pass, nothing changed | `There was nothing to transfer`, 0 B sent, no stored object written, no `history/` folder. |
| (b) A note modified | `current/` has the new version, `history/<ts of the pass>/` the old one, and only it. |
| (c) A note deleted | Gone from `current/`, in `history/<ts>/`. |
| (d) `.obsidian/workspace*.json` | Never stored, never logged; the rest of `.obsidian/` is stored. |
| (e) The bucket | No plain name (`current`, `history`, folders, notes, timestamps) in any path; every object starts with rclone crypt's magic and holds no note text. |
| (f) `verify` | `0 differences found`, exit 0; one stored byte flipped (same size and time): exit 1, `1 differences found`; back to 0 once restored; a note not stored yet: exit 1. |
| (g) Restore | `RESTORE.md`'s own `… restore-job.yaml … kubectl set env --local …` commands, run as written up to `kubectl create`: the versions of a note listed; the note restored identical byte for byte (and modification time), the other notes untouched; the same for a path holding `&`, `|`, `"`, `'`, `\`, `$`, `:` and `#`; its previous version from `history/<ts>/`. The whole vault, `restore-job.yaml` as it is, onto an empty volume: the same tree, bytes and times, then `verify` finds 0 differences. |
| Retention | `history/` folders of passes older than 7 days purged, newer kept, others left alone; a month-old note replaced today stays (by pass time, not file age). |
| An empty vault | Refused, nothing in the bucket touched. |
| A crypt password still `REPLACE-ME` | Refused. |

`MUTATE=exclude|backup-dir|cryptcheck|retention` breaks that part of the rendered script; `ci.sh` runs
each and requires the test to fail.

```bash
cd tests/obsidian-vault-backup && npm ci
npm test                                 # docker, kubectl on PATH (or KUBECTL=)
RUNNER=local npm test                    # sh and rclone 1.75.1 on PATH
```
