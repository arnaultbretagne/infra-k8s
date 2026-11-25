# Restoring the Obsidian vault

> **Without the two crypt passwords, the backup is lost.** `CRYPT_PASSWORD` and `CRYPT_PASSWORD2`
> (in `vault-backup.secrets.yaml`) encrypt every name and every byte stored in R2. There is no reset and no
> other key: R2 holds nothing anyone can read without them. The SOPS file opens with the cluster's age key
> only, so keep both passwords somewhere else too (a password manager), and never change them once a backup
> exists.

The backup (`vault-backup.yaml`, script `backup/vault-backup.sh`) keeps, on the rclone crypt remote
`backup:` over the bucket `obsidian-backup`:

| Where | What |
| --- | --- |
| `current/` | The vault as of the last pass (every 15 min), without `.obsidian/workspace*.json`. |
| `history/<YYYYMMDDTHHMMSSZ>/` | The versions that pass (UTC time) replaced or deleted, kept 7 days. |

So a note can be brought back as it was at the last pass, or as it was before any change made in the last
7 days. A whole vault comes back from `current/` only: `history/` holds the files that changed, not
snapshots.

`obsidian-vault-restore-test` runs the whole restore every day, from R2 into a throwaway folder, and compares
it with the vault; a failure is a critical alert (`ObsidianRestoreDrillFailed`).

Both restores below run `backup/restore-job.yaml`: the backup's own pod (image, script, Secret, network
policy) with the vault mounted read-write. It is not in `kustomization.yaml`; you create it, Flux never
does. `tests/obsidian-vault-backup` runs this Job's script and command, with these variables, and checks
the restored notes byte for byte.

## One note

Choose the version. `NOTE` is the path inside the vault; the Job, with `versions` instead of `restore`,
lists what is stored for it. `kubectl set env --local` writes the values into the Job (offline, quoted by
kubectl), so a path may hold any character: `&`, `|`, `"`, `'`, `\`, `$`, `:`, `#`.

```sh
NOTE='Projects/Idea.md'
job=$(sed -e 's|"restore"\]|"versions"]|' apps/obsidian/backup/restore-job.yaml |
  kubectl set env --local -f - RESTORE_PATH="$NOTE" -o yaml | kubectl -n obsidian create -f - -o name) && {
  kubectl -n obsidian wait --for=condition=complete "$job" --timeout=5m
  kubectl -n obsidian logs "$job"
}
```

Each line is `location;size;modification time`: `current/<NOTE>` is the last pass's copy,
`history/<ts>/<NOTE>` the version pass `<ts>` replaced or deleted. Then restore it, `FROM` being `current`
or `history/<ts>`:

```sh
FROM='history/20261120T101500Z'
job=$(kubectl set env --local -f apps/obsidian/backup/restore-job.yaml RESTORE_FROM="$FROM" RESTORE_PATH="$NOTE" -o yaml |
  kubectl -n obsidian create -f - -o name) && {
  kubectl -n obsidian wait --for=condition=complete "$job" --timeout=5m
  kubectl -n obsidian logs "$job"
}
```

The wait and the logs run only once the Job is created, and they are about that Job: its name is generated
(`generateName`), never an earlier one. The note is written back at its place in the vault, with its
stored modification time; the other notes are not touched. The writers may keep running. The vault's
version it replaces is not lost if a pass already stored it: the next pass moves it into `history/`.

## The whole vault

On a lost or emptied volume. The backup refuses to run on an empty vault, but a half-restored one would be
mirrored as it is: a pass running during the restore would move out of `current/`, into `history/`,
every file not restored yet. So everything that writes the vault or reads it for the backup is stopped
first, and the restore waits until it has actually stopped.

1. Stop Flux from undoing the next steps, then the backup's schedules and the writers:

   ```sh
   flux suspend kustomization apps
   kubectl -n obsidian patch cronjob obsidian-vault-backup obsidian-vault-verify obsidian-vault-restore-test -p '{"spec":{"suspend":true}}'
   kubectl -n obsidian scale deployment obsidian-mcp web-clipper ignis --replicas=0
   ```

   (The writers are `obsidian-mcp`, `web-clipper` and `ignis` (obsidian.bretagne.dev). A new writer of
   the vault is added to both the `scale` and the selector below.)

2. Wait until it has stopped. Suspending a CronJob does not stop a Job it has already started, and a pod
   scaled away may still be terminating: this loop ends only when no CronJob has an active Job and no
   pod of a writer or of the backup's Jobs is left, terminating ones included. A failed `kubectl` call
   counts as not stopped.

   ```sh
   until active=$(kubectl -n obsidian get cronjob obsidian-vault-backup obsidian-vault-verify obsidian-vault-restore-test \
           -o jsonpath='{.items[*].status.active[*].name}') &&
         writers=$(kubectl -n obsidian get pods -l 'app in (obsidian-mcp,web-clipper,ignis)' -o name) &&
         jobs=$(kubectl -n obsidian get pods -l app.kubernetes.io/part-of=obsidian-vault-backup \
           --field-selector=status.phase!=Succeeded,status.phase!=Failed -o name) &&
         [ -z "$active$writers$jobs" ]; do
     echo "still running: $active $writers $jobs"
     sleep 5
   done
   echo "stopped: the restore may start"
   ```

   A backup pass ends within 14 minutes (`activeDeadlineSeconds: 840`).

3. Restore `current/` into the vault (the template as it is: `RESTORE_FROM=current`, `RESTORE_PATH` empty):

   ```sh
   job=$(kubectl -n obsidian create -f apps/obsidian/backup/restore-job.yaml -o name) && {
     kubectl -n obsidian wait --for=condition=complete "$job" --timeout=30m
     kubectl -n obsidian logs "$job"
   }
   ```

   Files are copied, nothing in the vault is deleted: on a volume that was not empty, files the backup does
   not have stay.

4. Prove the vault is the backup: cryptcheck must end with `0 differences found` and `verify DONE`. The
   Job's name is new at each run, and the wait and the logs only follow its own creation, so an earlier
   verification is never the one read.

   ```sh
   vjob=$(kubectl -n obsidian create job --from=cronjob/obsidian-vault-verify \
     "verify-after-restore-$(date -u +%Y%m%d%H%M%S)" -o name) && {
     kubectl -n obsidian wait --for=condition=complete "$vjob" --timeout=30m
     kubectl -n obsidian logs "$vjob"
   }
   ```

5. Start everything again. The CronJobs' `suspend` is set by hand, not by the manifest, so Flux leaves it:
   unset it yourself.

   ```sh
   kubectl -n obsidian patch cronjob obsidian-vault-backup obsidian-vault-verify obsidian-vault-restore-test -p '{"spec":{"suspend":false}}'
   flux resume kustomization apps
   ```

## Without the cluster

From any machine with rclone 1.75 or later, this repository and the age key: the same script, its restore
mode, into a local directory. The variables are the ConfigMap `obsidian-vault-backup-env` of
`vault-backup.yaml` and the five keys of the SOPS Secret. Not run by the test.

```sh
f=apps/obsidian/vault-backup.secrets.yaml
for k in RCLONE_CONFIG_R2_ENDPOINT RCLONE_CONFIG_R2_ACCESS_KEY_ID RCLONE_CONFIG_R2_SECRET_ACCESS_KEY CRYPT_PASSWORD CRYPT_PASSWORD2; do
  export "$k=$(sops -d --extract "[\"stringData\"][\"$k\"]" "$f")"
done
export RCLONE_CONFIG=/dev/null RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
  RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true RCLONE_CONFIG_BACKUP_TYPE=crypt \
  RCLONE_CONFIG_BACKUP_REMOTE=r2:obsidian-backup RCLONE_CONFIG_BACKUP_FILENAME_ENCRYPTION=standard \
  RCLONE_CONFIG_BACKUP_DIRECTORY_NAME_ENCRYPTION=true
mkdir -p restored-vault
VAULT_DIR=./restored-vault RESTORE_FROM=current RESTORE_PATH= sh apps/obsidian/backup/vault-backup.sh restore
```

Without this repository, the same remotes by hand: an `s3` remote (provider Cloudflare, the endpoint and
keys) and over it, on `<remote>:obsidian-backup`, a `crypt` remote with filename encryption
`standard`, directory name encryption on, and the two passwords (`rclone config`, password then salt). Then
`rclone copy <crypt remote>:current ./restored-vault`.
