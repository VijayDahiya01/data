#!/bin/sh
# =============================================================================
# Restore from a backup taken by backup.sh.
#
# Destructive by definition: it drops and recreates the databases it restores.
# It therefore refuses to guess, and requires the directory to be named
# explicitly.
#
#   ./restore.sh /var/backups/oolix/20260903T031500Z
#
# Order matters. The applications are stopped first: restoring underneath a
# running API leaves it holding connections to tables that are being dropped,
# and the errors that produces have nothing to do with the real problem.
# =============================================================================
set -eu

SRC="${1:-}"
if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  echo "usage: restore.sh <backup-directory>" >&2
  exit 2
fi

COMPOSE_FILE="${COMPOSE_FILE:-infra/docker/compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.prod}"
DC="docker compose -f $COMPOSE_FILE --env-file $ENV_FILE"

# shellcheck disable=SC2046
export $(grep -E '^(POSTGRES_USER|POSTGRES_DB|KEYCLOAK_DB)=' "$ENV_FILE" | xargs) 2>/dev/null || true
PGUSER="${POSTGRES_USER:-oolix}"
APPDB="${POSTGRES_DB:-oolix}"
KCDB="${KEYCLOAK_DB:-keycloak}"

echo "verifying $SRC"
( cd "$SRC" && sha256sum -c SHA256SUMS ) || {
  echo "checksum mismatch: this backup is damaged, refusing to restore" >&2
  exit 1
}

echo "stopping applications"
$DC stop api portal worker keycloak >/dev/null

for db in "$APPDB" "$KCDB"; do
  [ -f "$SRC/$db.dump" ] || { echo "no dump for $db, skipping"; continue; }
  echo "restoring $db"
  # Terminate stragglers: a single idle connection blocks DROP DATABASE, and
  # the error names the database rather than the connection holding it.
  $DC exec -T postgres psql -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$db' AND pid<>pg_backend_pid()" >/dev/null
  $DC exec -T postgres psql -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 -c \
    "DROP DATABASE IF EXISTS \"$db\"" >/dev/null
  $DC exec -T postgres psql -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 -c \
    "CREATE DATABASE \"$db\"" >/dev/null
  $DC exec -T postgres pg_restore -U "$PGUSER" -d "$db" --no-owner < "$SRC/$db.dump"
done

if [ -f "$SRC/signing-keys.tar" ]; then
  echo "restoring signing keys"
  # Into the same volume the API mounts. Without this the API refuses to start
  # -- which is the correct behaviour, and exactly what a restore must undo.
  # As root, deliberately. The archive is 0600 and owned by whoever took the
  # backup, so the service account cannot read it -- and the restore then fails
  # after the databases are already back, which is the worst possible moment to
  # discover it. Ownership is handed back afterwards so the API can still write.
  $DC run --rm --no-deps -T --user root --entrypoint sh -v "$SRC:/backup:ro" api \
    -c 'tar -xf /backup/signing-keys.tar -C /app/.keys && chown -R node:node /app/.keys'
fi

echo "starting applications"
$DC up -d >/dev/null

echo "restored from $SRC"
cat "$SRC/manifest.txt" 2>/dev/null || true
