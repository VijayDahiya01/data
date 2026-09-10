#!/bin/sh
# =============================================================================
# Back up everything a pilot cannot recreate.
#
# Three things, and the third is the one people forget:
#
#   1. The Oolix database    — campaigns, approvals, activations, manifests
#   2. The Keycloak database — who can sign in, and as what
#   3. The signing keys      — the private keys behind every manifest
#
# The keys are not "configuration". Every manifest a Partner Agent has cached
# was signed by the manifest key; losing it means every Agent rejects every
# manifest it already holds, and no amount of restoring the database fixes
# that. A backup without the keys restores a system that cannot serve.
#
# The two databases are dumped separately rather than as one cluster dump.
# Keycloak owns its tables completely, and restoring an application database
# should never require restoring identity along with it.
#
#   ./backup.sh /var/backups/oolix
#
# Environment (all optional, sensible defaults for the compose stack):
#   COMPOSE_FILE   default infra/docker/compose.prod.yml
#   ENV_FILE       default .env.prod
# =============================================================================
set -eu

OUT_ROOT="${1:-}"
if [ -z "$OUT_ROOT" ]; then
  echo "usage: backup.sh <output-directory>" >&2
  exit 2
fi

COMPOSE_FILE="${COMPOSE_FILE:-infra/docker/compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.prod}"
DC="docker compose -f $COMPOSE_FILE --env-file $ENV_FILE"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_ROOT/$STAMP"
mkdir -p "$OUT"

# shellcheck disable=SC2046
export $(grep -E '^(POSTGRES_USER|POSTGRES_DB|KEYCLOAK_DB)=' "$ENV_FILE" | xargs) 2>/dev/null || true
PGUSER="${POSTGRES_USER:-oolix}"
APPDB="${POSTGRES_DB:-oolix}"
KCDB="${KEYCLOAK_DB:-keycloak}"

echo "backing up to $OUT"

# --- databases ---------------------------------------------------------------
#
# Custom format, not plain SQL: it restores in parallel, it can be restored
# selectively, and pg_restore refuses a truncated file instead of replaying
# half of it.
for db in "$APPDB" "$KCDB"; do
  echo "  pg_dump $db"
  $DC exec -T postgres pg_dump -U "$PGUSER" -d "$db" --format=custom --no-owner \
    > "$OUT/$db.dump"
  # A zero-byte dump from a disk-full or a dead container is otherwise
  # indistinguishable from a successful backup of an empty database.
  if [ ! -s "$OUT/$db.dump" ]; then
    echo "  FAILED: $db.dump is empty" >&2
    exit 1
  fi
done

# --- signing keys ------------------------------------------------------------
echo "  signing keys"
$DC exec -T api tar -cf - -C /app/.keys . > "$OUT/signing-keys.tar"
if [ ! -s "$OUT/signing-keys.tar" ]; then
  echo "  FAILED: signing-keys.tar is empty" >&2
  exit 1
fi
chmod 0600 "$OUT/signing-keys.tar"

# --- what this backup is -----------------------------------------------------
{
  echo "taken_at=$STAMP"
  echo "app_database=$APPDB"
  echo "keycloak_database=$KCDB"
  echo "image_tag=$(grep -E '^IMAGE_TAG=' "$ENV_FILE" | cut -d= -f2- || echo unknown)"
  echo "schema_migration=$($DC exec -T postgres psql -U "$PGUSER" -d "$APPDB" -tAc \
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1' 2>/dev/null | tr -d '\r' || echo unknown)"
} > "$OUT/manifest.txt"

# Checksums, because the failure this catches is silent: a truncated dump
# restores without complaint right up to the point where it does not.
( cd "$OUT" && sha256sum ./*.dump ./*.tar > SHA256SUMS )

echo "done: $OUT"
ls -la "$OUT"
