#!/usr/bin/env bash
# Destructive: drops the database and n8n data, then re-bootstraps.
set -euo pipefail
cd "$(dirname "$0")/.."
read -r -p "This deletes the Postgres and n8n volumes. Continue? [y/N] " ans
[ "$ans" = "y" ] || exit 1
docker compose down -v
bash scripts/bootstrap.sh
