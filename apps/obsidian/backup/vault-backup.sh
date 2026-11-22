#!/bin/sh
# The Obsidian vault's backup, encrypted by rclone crypt on the dedicated R2 bucket (vault-backup.yaml).
# One script, three modes, run by busybox sh in the rclone/rclone image:
#
#   backup   every 15 min: `rclone sync` of the vault to backup:current. A file this pass replaces or
#            deletes is moved, not lost, to backup:history/<UTC timestamp of the pass>/; history
#            folders older than RETENTION_DAYS are purged.
#   verify   weekly: `rclone cryptcheck` of the vault against backup:current. Any difference (a file
#            changed, missing on either side, or a stored object that no longer decrypts to the
#            vault's bytes) exits non-zero, so the Job fails and CronJobLastRunFailed fires.
#   restore  by hand (restore-job.yaml, apps/obsidian/RESTORE.md): RESTORE_PATH from RESTORE_FROM
#            (`current` or `history/<ts>`) into the vault; the whole of RESTORE_FROM when
#            RESTORE_PATH is empty.
#   versions by hand, the same Job: lists the stored versions of RESTORE_PATH.
#
# The remotes come from the environment the manifests set: `r2` (s3, Cloudflare) and `backup`
# (crypt over r2:<bucket>). Only the crypt passwords are handled here: the Secret holds them in
# clear, as they must be kept to restore anything, and rclone wants them obscured.
#
# tests/obsidian-vault-backup runs this file, as rendered by kustomize, in the image of the
# manifests.
set -eu

VAULT="${VAULT_DIR:?VAULT_DIR is the vault mount}"
RETENTION_DAYS=7
# Obsidian's window layout: rewritten on every click, worthless to restore.
EXCLUDE='/.obsidian/workspace*.json'
# One sync per pass, so every file is read once and a replaced version has history/<ts> to itself;
# no size filter, so a file is always compared with its stored version. After PASS_BUDGET rclone
# starts no new transfer, and one running is never cut: it finishes. All checks first, then one
# transfer at a time, the largest file left first: a file that can be sent within the Job's deadline
# at all is sent by the first pass where it is the largest left, and a later one, no larger than one
# already sent, ends by twice the budget. A pass thus ends by about 2 x PASS_BUDGET = 12 min, inside
# activeDeadlineSeconds (840 s, vault-backup.yaml); what it did not start, the next pass sends. PR
# #397 has the arithmetic.
PASS_BUDGET=6m

# rclone gives up on R2 within seconds, and says so. With its defaults, one request R2 never answers
# is retried for over an hour without a line at -v: 1 min to connect, 10 low-level retries, each of
# them the S3 SDK's own 10 attempts, all logged at debug level only (obsidian-vault-backup-29921265
# and -29921280, 2026-11-21: nothing after "==> sync" until the deadline). Here a request gets 2 x 2
# attempts, each 10 s to connect (TLS included) and 20 s without a byte; a failed command is not run
# again: the next pass is the retry (backoffLimit: 0).
export RCLONE_CONTIMEOUT=10s RCLONE_TIMEOUT=20s RCLONE_LOW_LEVEL_RETRIES=2 RCLONE_RETRIES=1

for name in CRYPT_PASSWORD CRYPT_PASSWORD2; do
  eval "value=\${$name:-}"
  case "$value" in
    '' | REPLACE-ME*)
      echo "$name is not set: fill it in apps/obsidian/vault-backup.secrets.yaml (sops)" >&2
      exit 1
      ;;
  esac
done
RCLONE_CONFIG_BACKUP_PASSWORD="$(printf '%s' "$CRYPT_PASSWORD" | rclone obscure -)"
RCLONE_CONFIG_BACKUP_PASSWORD2="$(printf '%s' "$CRYPT_PASSWORD2" | rclone obscure -)"
export RCLONE_CONFIG_BACKUP_PASSWORD RCLONE_CONFIG_BACKUP_PASSWORD2

# 20261120T101500Z -> 20261120101500, comparable as a number.
ts_number() {
  t="${1%Z}"
  echo "${t%T*}${t#*T}"
}

# R2 first, in one attempt (one request, at most 10 s to connect, 20 s to answer): unreachable, it is
# rclone's error in the log within seconds, not a pass that waits for its deadline. Exit 3 (nothing
# stored yet) is an answer too.
reach_r2() {
  echo "==> reach R2: list backup:"
  rc=0
  rclone lsf --max-depth 1 --low-level-retries 1 backup: > /dev/null || rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 3 ]; then
    echo "R2 did not answer (rclone exit $rc, its error above): nothing done" >&2
    exit 1
  fi
}

case "${1:-}" in
  backup)
    # An empty vault is a lost or unmounted volume, never a vault to mirror: syncing it would move
    # every note to history/, and the retention would delete them 7 days later.
    if [ -z "$(ls -A "$VAULT")" ]; then
      echo "refusing to back up: $VAULT is empty" >&2
      exit 1
    fi
    reach_r2
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    echo "==> sync $VAULT -> backup:current (replaced and deleted files -> backup:history/$ts)"
    rc=0
    rclone sync "$VAULT" backup:current \
      --backup-dir "backup:history/$ts" \
      --exclude "$EXCLUDE" \
      --check-first --order-by size,descending --transfers 1 \
      --max-duration "$PASS_BUDGET" --cutoff-mode soft \
      --stats 1m \
      --fast-list -v || rc=$?
    if [ "$rc" -eq 10 ]; then
      # Exit 10, --max-duration. sync deletes nothing after an error: the next pass resumes.
      echo "==> sync stopped at its $PASS_BUDGET budget, every transfer started finished: the next pass sends the rest" >&2
    fi
    [ "$rc" -eq 0 ] || exit "$rc"
    cutoff="$(date -u -d "@$(($(date +%s) - RETENTION_DAYS * 86400))" +%Y%m%dT%H%M%SZ)"
    echo "==> purge history older than $cutoff"
    # Exit 3: no history yet.
    dirs="$(rclone lsf --dirs-only backup:history)" || [ $? -eq 3 ]
    for dir in $dirs; do
      dir="${dir%/}"
      case "$dir" in
        [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
        *) continue ;;
      esac
      # By the pass's timestamp, not by the files' modification times: a note untouched for a
      # month and replaced today is a version from today.
      if [ "$(ts_number "$dir")" -lt "$(ts_number "$cutoff")" ]; then
        echo "purge backup:history/$dir"
        rclone purge "backup:history/$dir"
      fi
    done
    echo "==> backup DONE ($ts)"
    ;;
  verify)
    reach_r2
    echo "==> cryptcheck $VAULT against backup:current"
    rclone cryptcheck "$VAULT" backup:current --exclude "$EXCLUDE" -v
    echo "==> verify DONE: the stored copy matches the vault"
    ;;
  restore)
    from="${RESTORE_FROM:-current}"
    path="${RESTORE_PATH:-}"
    case "$from" in
      current | history/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
      *)
        echo "RESTORE_FROM must be current or history/<YYYYMMDDTHHMMSSZ>, not '$from'" >&2
        exit 1
        ;;
    esac
    reach_r2
    if [ -n "$path" ]; then
      echo "==> restore backup:$from/$path -> $VAULT/$path"
      rclone copyto "backup:$from/$path" "$VAULT/$path" -v
    else
      echo "==> restore backup:$from -> $VAULT (whole tree)"
      rclone copy "backup:$from" "$VAULT" --exclude "$EXCLUDE" -v
    fi
    echo "==> restore DONE"
    ;;
  versions)
    path="${RESTORE_PATH:?RESTORE_PATH is the note to look for}"
    reach_r2
    echo "==> stored versions of $path (location;size;modification time)"
    # current/<path> is the latest; history/<ts>/<path> the version that pass <ts> replaced.
    rclone lsf -R --files-only --format pst backup: | grep -F -- "/$path;" ||
      echo "no stored version of $path"
    ;;
  *)
    echo "usage: $0 backup|verify|restore|versions" >&2
    exit 2
    ;;
esac
