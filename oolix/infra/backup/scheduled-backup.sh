#!/bin/sh
# =============================================================================
# Scheduled backups, as a service.
#
# `backup.sh` is the one an operator runs by hand. This is the one that runs
# whether anyone remembers or not, which is the only kind that helps.
#
# # Why this does not use `docker compose exec`
#
# The manual script shells into the running Postgres container, which needs the
# Docker socket. Mounting that socket into a long-lived container is handing it
# root on the host: anything that compromises the backup job compromises the
# machine. This one speaks to Postgres over the network with pg_dump instead,
# and reads the signing keys from a read-only volume mount. It can therefore
# run unprivileged, and the worst it can do is read what it is meant to back up.
#
# # What it refuses to do
#
# A backup job that fails quietly is worse than none, because it replaces
# "we have no backups" with "we believe we have backups". So: an empty dump is
# an error, a missing key archive is an error, and every failure is announced
# on stdout where the container log collector will see it.
#
# Environment:
#   PGHOST PGUSER PGPASSWORD    the Oolix database
#   APP_DB KEYCLOAK_DB          database names
#   BACKUP_DIR                  where to write (mount this OFF-HOST)
#   BACKUP_INTERVAL_SECONDS     default 86400
#   BACKUP_KEEP                 how many to retain locally, default 7
#   KEYS_DIR                    the signing keys, mounted read-only
# =============================================================================
set -eu

APP_DB="${APP_DB:-oolix}"
KEYCLOAK_DB="${KEYCLOAK_DB:-keycloak}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
BACKUP_KEEP="${BACKUP_KEEP:-7}"
KEYS_DIR="${KEYS_DIR:-/keys}"

log() { echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

run_backup() {
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  out="$BACKUP_DIR/$stamp"
  mkdir -p "$out"

  log "starting -> $out"

  # Custom format: restores in parallel, restores selectively, and pg_restore
  # refuses a truncated file rather than replaying half of it.
  for db in "$APP_DB" "$KEYCLOAK_DB"; do
    if ! pg_dump -d "$db" --format=custom --no-owner > "$out/$db.dump" 2>"$out/$db.err"; then
      log "FAILED: pg_dump $db -- $(head -c 300 "$out/$db.err")"
      return 1
    fi
    rm -f "$out/$db.err"
    # A zero-byte dump from a full disk is otherwise indistinguishable from a
    # successful backup of an empty database.
    if [ ! -s "$out/$db.dump" ]; then
      log "FAILED: $db.dump is empty"
      return 1
    fi
    log "  $db $(wc -c < "$out/$db.dump") bytes"
  done

  # The signing keys. Losing these means every manifest a Partner Agent has
  # cached is rejected, and no database restore fixes that.
  if [ -d "$KEYS_DIR" ] && [ -n "$(ls -A "$KEYS_DIR" 2>/dev/null)" ]; then
    tar -cf "$out/signing-keys.tar" -C "$KEYS_DIR" .
    chmod 0600 "$out/signing-keys.tar"
    log "  signing keys $(wc -c < "$out/signing-keys.tar") bytes"
  else
    # Not a warning. A backup without the keys restores a system that cannot
    # serve, and the operator has to know that now rather than during a
    # recovery.
    log "FAILED: no signing keys found at $KEYS_DIR -- a backup without them cannot restore a working system"
    return 1
  fi

  {
    echo "taken_at=$stamp"
    echo "app_database=$APP_DB"
    echo "keycloak_database=$KEYCLOAK_DB"
    echo "scheduled=true"
  } > "$out/manifest.txt"

  # Checksums, because a truncated dump restores without complaint right up to
  # the point where it does not.
  ( cd "$out" && sha256sum ./*.dump ./*.tar > SHA256SUMS )

  log "done -> $out"
}

prune() {
  # Local retention only. This is a convenience so one disk does not fill; it
  # is NOT a retention policy. Whatever copies these off-host owns that.
  count=$(ls -1d "$BACKUP_DIR"/*/ 2>/dev/null | wc -l)
  if [ "$count" -gt "$BACKUP_KEEP" ]; then
    ls -1d "$BACKUP_DIR"/*/ | head -n "$((count - BACKUP_KEEP))" | while read -r old; do
      log "pruning $old"
      rm -rf "$old"
    done
  fi
}

log "scheduled backups every ${BACKUP_INTERVAL_SECONDS}s, keeping ${BACKUP_KEEP} locally"
log "REMINDER: $BACKUP_DIR must be a mount that leaves this host. A backup on the"
log "          same disk as the database survives only the failures that do not matter."

while true; do
  if run_backup; then
    prune
  else
    # Kept running rather than exiting: the next window may succeed, and a
    # crash-looping container is easy to miss among restarts.
    log "BACKUP FAILED -- this is an alertable condition"
  fi
  sleep "$BACKUP_INTERVAL_SECONDS"
done
