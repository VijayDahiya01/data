#!/usr/bin/env bash
# Runs the Partner Connect bundle -- partner/pack/docker-compose.partner.yml,
# the file a Partner downloads -- in real containers, and checks what a Partner
# relies on before anything is configured:
#
#   - the containers start in order: init writes the store password, the local
#     store becomes healthy, the Agent connects to it;
#   - the setup page answers on 127.0.0.1:8083, and its password is in the
#     Agent's log, once;
#   - that password signs in, and a wrong one does not;
#   - the Agent runs as the unprivileged user, and the store is not published;
#   - after `docker compose down` and `up` with the volumes kept, the store
#     password is unchanged, no new setup password is printed, and the first
#     one still signs in.
#
# Usage: bash scripts/verify-compose-bundle.sh <agent-image>
# Needs docker with the compose plugin, and curl. No Oolix API is needed: an
# Agent that has not been registered serves only its setup page.
set -euo pipefail

image="${1:?usage: verify-compose-bundle.sh <agent-image>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
file="$work/docker-compose.yml"
project=oolix-bundle-check

compose() { docker compose -f "$file" -p "$project" "$@"; }
cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  compose ps -a >&2 || true
  compose logs --no-color >&2 || true
  exit 1
}
pass() { echo "ok   $*"; }

# The bundle as the API serves it, with this build's image. Nothing listens at
# the API address: the check never registers the Agent.
sed -e "s#REPLACE_WITH_AGENT_IMAGE#${image}#" -e "s#REPLACE_WITH_API_URL#http://127.0.0.1:9#" \
  "$root/partner/pack/docker-compose.partner.yml" >"$file"
mkdir -p "$work/import"

wait_for_setup_page() {
  for _ in $(seq 1 90); do
    if curl -fsS -o /dev/null http://127.0.0.1:8083/login 2>/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}

# Signs in and opens the overview, as a Partner would.
sign_in() {
  local jar="$work/cookies" code
  rm -f "$jar"
  code=$(curl -sS -o /dev/null -w '%{http_code}' -c "$jar" \
    --data-urlencode "password=$1" http://127.0.0.1:8083/login)
  [ "$code" = 303 ] || return 1
  curl -fsS -b "$jar" http://127.0.0.1:8083/ | grep -q 'Connect your customer data to Oolix'
}

logged_passwords() {
  compose logs --no-color agent | grep -o '"setup_password":"[a-z0-9-]*"' || true
}

compose up -d --quiet-pull || fail "the bundle did not start"
wait_for_setup_page || fail "the setup page never answered on 127.0.0.1:8083"
pass "setup page answers"

[ "$(docker inspect -f '{{.State.ExitCode}}' "$(compose ps -aq init)")" = 0 ] ||
  fail "init did not finish cleanly"
pass "init wrote the store password and exited"

[ "$(logged_passwords | wc -l)" -eq 1 ] || fail "the setup password was not logged exactly once"
password=$(logged_passwords | cut -d'"' -f4)
pass "setup password logged once"

sign_in "$password" || fail "the logged password did not sign in"
if sign_in "not-the-setup-password"; then fail "a wrong password signed in"; fi
pass "the password signs in, a wrong one does not"

[ "$(docker inspect -f '{{.Config.User}}' "$(compose ps -q agent)")" = 65532:65532 ] ||
  fail "the Agent does not run as 65532:65532"
if compose port local-store 5432 >/dev/null 2>&1; then fail "the local store is published on the host"; fi
pass "the Agent is unprivileged and the store is not published"

store_password=$(compose exec -T local-store cat /run/oolix/store-password)
compose down || fail "the bundle did not stop"
compose up -d --quiet-pull || fail "the bundle did not start again"
wait_for_setup_page || fail "the setup page did not come back after a restart"
[ "$(compose exec -T local-store cat /run/oolix/store-password)" = "$store_password" ] ||
  fail "the store password changed on restart"
[ "$(logged_passwords | wc -l)" -eq 0 ] || fail "a new setup password was printed after a restart"
sign_in "$password" || fail "the first password no longer signs in after a restart"
pass "the store, its password and the setup password survive a restart"

echo "The Partner Connect bundle works in real containers."
