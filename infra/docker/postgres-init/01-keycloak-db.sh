#!/bin/sh
# Keycloak needs its own database, and nothing was creating it.
#
# The compose file points KC_DB_URL at a `keycloak` database while the Postgres
# image creates only POSTGRES_DB, so Keycloak crash-looped on
# `FATAL: database "keycloak" does not exist` — after the rest of the stack had
# come up healthy, which makes it look like an identity problem rather than a
# missing database.
#
# Its own database rather than a schema inside the application's: Keycloak owns
# its tables completely, and a restore of one should never be entangled with
# the other.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
SELECT 'CREATE DATABASE ${KEYCLOAK_DB:-keycloak}'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${KEYCLOAK_DB:-keycloak}')\gexec
SQL
