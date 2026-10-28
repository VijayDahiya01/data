#!/bin/sh
# Starts the Agent inside the enclave: the loopback interface (an enclave
# starts without one), the local store in memory, then the Agent, which
# reaches everything else through its host (see cmd/enclave-host).
set -eu

ip link set dev lo up

mkdir -p /run/oolix/state /run/pg
chmod 0700 /run/oolix/state
chown postgres:postgres /run/pg

# Trust on loopback is safe here: nothing outside the enclave can reach it.
su-exec postgres initdb -D /run/pg/data --auth=trust --username=oolix --encoding=UTF8 >/dev/null
su-exec postgres pg_ctl -D /run/pg/data -l /run/pg/log \
  -o "-c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off -c synchronous_commit=off" \
  -w start >/dev/null
su-exec postgres createdb -h 127.0.0.1 -U oolix oolix

exec /usr/local/bin/oolix-agent -managed
