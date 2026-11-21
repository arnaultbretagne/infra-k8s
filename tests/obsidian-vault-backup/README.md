# obsidian-vault-backup: the vault backup's own script, run as deployed

The proof that the Obsidian vault backup (`apps/obsidian/vault-backup.yaml`) does what it says, run by the
`tests` workflow (`ci.sh`, `ci.paths`; `tests/README.md`) on every pull request touching `apps/obsidian`:

- **What runs:** `kubectl kustomize apps/obsidian`, as Flux applies it. The script is the rendered ConfigMap
  `obsidian-vault-backup-scripts`; each run takes a CronJob's (or `apps/obsidian/backup/restore-job.yaml`'s)
  image, command, environment (`envFrom` resolved from the render) and mounts. `obsidian-data` is a
  directory with its `vault/` subPath, read-only where the manifest says so.
- **Where:** `docker run` of the manifests' `rclone/rclone` image (the one `ha-config-backup` uses), its root
  read-only, no capability, no privilege escalation, no network (the host's, for the two R2-out-of-reach cases
  only: they reach a port of the test on 127.0.0.1), as the caller's uid (the pod runs 1000; the
  script does not depend on it). `RUNNER=local` instead runs `sh` and `rclone` from `PATH`, after checking
  that `rclone version` is the manifests' version.
- **The one change:** the `r2` remote is rclone's `local` backend instead of `s3`
  (`RCLONE_CONFIG_R2_TYPE=local`), a directory standing for the bucket. The crypt remote `backup` over it
  is the real one. The R2-out-of-reach cases keep the manifests' `s3`, their endpoint a port of the test.
- **Secrets:** none real. The Secret's keys are the SOPS file's, with made-up values.

| Case | Expected |
| --- | --- |
| The manifests | Image = `ha-config-backup`'s; backup every 15 min, verify weekly, both `Forbid`; the PVC `obsidian-data`, subPath `vault`, read-only; the pod security of the criteria; the Secret SOPS-encrypted for `.sops.yaml`'s recipient, nothing in clear; the network policy: DNS, and 443 to `*.r2.cloudflarestorage.com` only, nothing in; the host firewall (`bootstrap/bootstrap.sh`, input `policy drop`) accepts from the pod CIDR what Cilium marks for its proxies (`0x200/0xf00`), without which the DNS proxy of that policy never gets a query. |
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
| R2 drops the connection (SYN unanswered, as a Cilium deny does), or accepts it and never answers | The manifests' own `r2` remote (s3), its endpoint a port of the test that never accepts (its queue full, for the drop): the pass fails within seconds (~20 s), before `==> sync`, with rclone's `ERROR` (`dial tcp …: i/o timeout`, `TLS handshake timeout`). Waited 90 s at most, far inside the Job's 840 s: the script as it hung on the cluster (`MUTATE=silent`) had still not written a line. |
| The budgets | Step 1 (files up to `SMALL`, 4M) and step 2 (every file, one at a time, the largest first, `--check-first`) stop starting transfers at their budgets, soft: none is cut. `SMALL_BUDGET + 2 × LARGE_BUDGET` leaves 2 min of the Job's deadline. |
| Convergence, conditions constant | The script at 1/30 of its durations (budgets 4 s and 8 s, the deadline 28 s), R2 at 32 KiB/s at every pass: a 512 KiB file (16 s, twice the budget) is sent whole by the first pass, three 128 KiB files by the next ones; no pass reaches the deadline, each stores something, the last ends at exit 0, and `verify` finds 0 differences. |
| A file too large for any pass | 1 MiB at 32 KiB/s (32 s, beyond the 28 s deadline): the pass reaches the deadline sending it, rclone's progress naming it, and the note changed meanwhile is stored all the same (step 1). |

`MUTATE=exclude|backup-dir|cryptcheck|retention|silent|budget|hard|one-step` breaks that part of the rendered
script (`silent`: rclone's default timeouts and retries, no check of R2 first; `budget`: step 2 without
`--max-duration`; `hard`: its cutoff hard, which cuts the transfer running; `one-step`: no step 1);
`ci.sh` runs each and requires the test to fail. The slow cases only run when unmutated or under their own
mutation.

```bash
cd tests/obsidian-vault-backup && npm ci
npm test                                 # docker, kubectl on PATH (or KUBECTL=)
RUNNER=local npm test                    # sh and rclone 1.75.1 on PATH
```
