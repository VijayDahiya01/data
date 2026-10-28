#!/usr/bin/env bash
# Installs the Oolix Partner Agent as a systemd service, without Docker.
#
#   sudo ./install-linux.sh https://api.oolix.example ./oolix-agent
#
# It needs a PostgreSQL 13+ for the Agent's own local store -- one already on
# this server, or any the server can reach. The script prints the two
# statements that create the store's database and login; run them there.
# Nothing is created in the database that holds your customers.
set -euo pipefail

api="${1:?usage: install-linux.sh <oolix-api-url> <path-to-oolix-agent-binary>}"
binary="${2:?usage: install-linux.sh <oolix-api-url> <path-to-oolix-agent-binary>}"
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

id oolix-agent >/dev/null 2>&1 || useradd --system --home /var/lib/oolix-agent --shell /usr/sbin/nologin oolix-agent
install -d -m 0700 -o oolix-agent -g oolix-agent /var/lib/oolix-agent /var/lib/oolix-agent/import
install -d -m 0750 -o root -g oolix-agent /etc/oolix-agent
install -m 0755 "$binary" /usr/local/bin/oolix-agent

if [ ! -s /etc/oolix-agent/store-password ]; then
  tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40 >/etc/oolix-agent/store-password
fi
chown root:oolix-agent /etc/oolix-agent/store-password
chmod 0640 /etc/oolix-agent/store-password

if [ ! -f /etc/oolix-agent/agent.env ]; then
  cat >/etc/oolix-agent/agent.env <<EOF
OOLIX_API_BASE_URL=${api}
# The Agent's local store: a database of its own, not your customer database.
OOLIX_LOCAL_STORE_URL=postgres://oolix_agent@localhost:5432/oolix_agent?sslmode=disable
OOLIX_LOCAL_STORE_PASSWORD_FILE=/etc/oolix-agent/store-password
OOLIX_STATE_DIR=/var/lib/oolix-agent
OOLIX_IMPORT_FOLDER=/var/lib/oolix-agent/import
# The setup page, on this server only. Reach it with: ssh -L 8083:localhost:8083 you@this-server
OOLIX_SETUP_LISTEN_ADDR=127.0.0.1:8083
EOF
  chmod 0640 /etc/oolix-agent/agent.env
  chown root:oolix-agent /etc/oolix-agent/agent.env
fi

here="$(cd "$(dirname "$0")" && pwd)"
install -m 0644 "$here/oolix-agent.service" /etc/systemd/system/oolix-agent.service
systemctl daemon-reload

cat <<EOF

Installed. Before starting, create the Agent's local store on PostgreSQL
(as a superuser, on the server in OOLIX_LOCAL_STORE_URL):

  CREATE ROLE oolix_agent LOGIN PASSWORD '$(cat /etc/oolix-agent/store-password)';
  CREATE DATABASE oolix_agent OWNER oolix_agent;

Then:

  sudo systemctl enable --now oolix-agent
  sudo journalctl -u oolix-agent | grep setup_password

and open the setup page (http://localhost:8083 on this server).
EOF
