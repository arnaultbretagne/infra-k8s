# Restoring the Obsidian vault

> **Without the two crypt passwords, the backup is lost.** `CRYPT_PASSWORD` and `CRYPT_PASSWORD2`
> (in `vault-backup.secrets.yaml`) encrypt every name and every byte stored in R2. There is no reset and no
> other key: R2 holds nothing anyone can read without them. The SOPS file opens with the cluster's age key
> only, so keep both passwords somewhere else too (a password manager), and never change them once a backup
> exists.

The backup (`vault-backup.yaml`, script `backup/vault-backup.sh`) keeps, on the rclone crypt remote
`backup:` over the bucket `bretagne-obsidian-backup`:

| Where | What |
| --- | --- |
| `current/` | The vault as of the last pass (every 15 min), without `.obsidian/workspace*.json`. |
| `history/<YYYYMMDDTHHMMSSZ>/` | The versions that pass (UTC time) replaced or deleted, kept 7 days. |

So a note can be brought back as it was at the last pass, or as it was before any change made in the last
7 days. A whole vault comes back from `current/` only: `history/` holds the files that changed, not
snapshots.

Both restores below run `backup/restore-job.yaml`: the backup's own pod (image, script, Secret, network
policy) with the vault mounted read-write. It is not in `kustomization.yaml`; you create it, Flux never
does. `tests/obsidian-vault-backup` runs this Job's script and command, with these variables, and checks
the restored notes byte for byte.

## One note

Choose the version. `NOTE` is the path inside the vault; the Job, with `versions` instead of `restore`,
lists what is stored for it:

```sh
NOTE='Projects/Idea.md'
job=$(sed -e "s|value: \"\"|value: \"$NOTE\"|" -e 's|"restore"\]|"versions"]|' \
  apps/obsidian/backup/restore-job.yaml | kubectl -n obsidian create -f - -o name)
kubectl -n obsidian wait --for=condition=complete "$job" --timeout=5m && kubectl -n obsidian logs "$job"
```

Each line is `location;size;modification time`: `current/<NOTE>` is the last pass's copy,
`history/<ts>/<NOTE>` the version pass `<ts>` replaced or deleted. Then restore it, `FROM` being `current`
or `history/<ts>`:

```sh
FROM='history/20261120T101500Z'
job=$(sed -e "s|value: current|value: \"$FROM\"|" -e "s|value: \"\"|value: \"$NOTE\"|" \
  apps/obsidian/backup/restore-job.yaml | kubectl -n obsidian create -f - -o name)
kubectl -n obsidian wait --for=condition=complete "$job" --timeout=5m && kubectl -n obsidian logs "$job"
```

The note is written back at its place in the vault, with its stored modification time; the other notes are
not touched. The writers may keep running. The vault's version it replaces is not lost if a pass already
stored it: the next pass moves it into `history/`. (A path holding `|` or `"` needs the two values edited
in a copy of the file instead of `sed`.)

## The whole vault

On a lost or emptied volume. The backup refuses to run on an empty vault, but a half-restored one would be
mirrored as it is, so it is stopped first, with everything that writes the vault.

1. Stop Flux from undoing the next steps, then the writers and the backup:

   ```sh
   flux suspend kustomization apps
   kubectl -n obsidian scale deployment obsidian-mcp web-clipper obsidian-sync --replicas=0
   kubectl -n obsidian patch cronjob obsidian-vault-backup -p '{"spec":{"suspend":true}}'
   ```

   (Deployments that do not exist any more, such as `obsidian-sync` once retired, are just left out; a new
   writer of the vault is added.)

2. Restore `current/` into the vault (the template as it is: `RESTORE_FROM=current`, `RESTORE_PATH` empty):

   ```sh
   job=$(kubectl -n obsidian create -f apps/obsidian/backup/restore-job.yaml -o name)
   kubectl -n obsidian wait --for=condition=complete "$job" --timeout=30m && kubectl -n obsidian logs "$job"
   ```

   Files are copied, nothing in the vault is deleted: on a volume that was not empty, files the backup does
   not have stay.

3. Prove the vault is the backup: cryptcheck must find `0 differences`.

   ```sh
   kubectl -n obsidian create job --from=cronjob/obsidian-vault-verify verify-after-restore
   kubectl -n obsidian wait --for=condition=complete job/verify-after-restore --timeout=30m
   kubectl -n obsidian logs job/verify-after-restore
   ```

4. Start everything again. The CronJob's `suspend` is set by hand, not by the manifest, so Flux leaves it:
   unset it yourself.

   ```sh
   kubectl -n obsidian patch cronjob obsidian-vault-backup -p '{"spec":{"suspend":false}}'
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
  RCLONE_CONFIG_BACKUP_REMOTE=r2:bretagne-obsidian-backup RCLONE_CONFIG_BACKUP_FILENAME_ENCRYPTION=standard \
  RCLONE_CONFIG_BACKUP_DIRECTORY_NAME_ENCRYPTION=true
mkdir -p restored-vault
VAULT_DIR=./restored-vault RESTORE_FROM=current RESTORE_PATH= sh apps/obsidian/backup/vault-backup.sh restore
```

Without this repository, the same remotes by hand: an `s3` remote (provider Cloudflare, the endpoint and
keys) and over it, on `<remote>:bretagne-obsidian-backup`, a `crypt` remote with filename encryption
`standard`, directory name encryption on, and the two passwords (`rclone config`, password then salt). Then
`rclone copy <crypt remote>:current ./restored-vault`.
