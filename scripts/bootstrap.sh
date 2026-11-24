#!/usr/bin/env bash
# One-shot setup: start the stack, import credentials + workflows, publish them,
# and create a local n8n owner account. Re-runnable.
set -euo pipefail
cd "$(dirname "$0")/.."

# Git Bash / MSYS would otherwise rewrite /container/paths into Windows paths.
export MSYS_NO_PATHCONV=1

if [ ! -f .env ]; then
  cp .env.example .env
  KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  if sed --version >/dev/null 2>&1; then
    sed -i "s/^N8N_ENCRYPTION_KEY=.*/N8N_ENCRYPTION_KEY=$KEY/" .env
  else
    sed -i '' "s/^N8N_ENCRYPTION_KEY=.*/N8N_ENCRYPTION_KEY=$KEY/" .env
  fi
  echo "created .env from .env.example"
fi

set -a; . ./.env; set +a
mkdir -p runtime/logs

wait_for_n8n() {
  for i in $(seq 1 120); do
    if curl -fsS http://localhost:5678/healthz >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "n8n did not become healthy" >&2
  docker compose logs --tail=40 n8n >&2
  return 1
}

echo "==> starting containers"
docker compose up -d
wait_for_n8n

echo "==> generating workflow JSON"
node scripts/build-workflows.mjs

echo "==> importing postgres credential"
TMP=$(mktemp -d)
cat > "$TMP/cred.json" <<JSON
[{
  "id": "ithd-postgres",
  "name": "IT Helpdesk Postgres",
  "type": "postgres",
  "data": {
    "host": "postgres",
    "port": 5432,
    "database": "${POSTGRES_DB:-helpdesk}",
    "user": "${POSTGRES_USER:-n8n}",
    "password": "${POSTGRES_PASSWORD:-n8n_local_dev}",
    "ssl": "disable"
  }
}]
JSON
docker compose exec -T n8n sh -c 'cat > /tmp/cred.json' < "$TMP/cred.json"
docker compose exec -T n8n n8n import:credentials --input=/tmp/cred.json
rm -rf "$TMP"

echo "==> importing workflows"
docker compose exec -T n8n n8n import:workflow --separate --input=/workflows

echo "==> publishing workflows (n8n 2.x needs published workflows for webhooks)"
IDS=$(docker compose exec -T n8n n8n list:workflow --onlyId 2>/dev/null | tr -d '\r' | grep -E '^[A-Za-z0-9_-]+$' || true)
for id in $IDS; do
  docker compose exec -T n8n n8n publish:workflow --id="$id" >/dev/null && echo "   published $id"
done

echo "==> restarting n8n so the published versions serve webhooks"
docker compose restart n8n >/dev/null
docker compose up -d n8n >/dev/null 2>&1
wait_for_n8n

echo "==> waiting for webhooks to be live"
# probing the approval webhook: side-effect free (invalid token -> 410 page)
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    'http://localhost:5678/webhook/it-helpdesk/approval?token=probe&decision=approved' || true)
  if [ "$code" != "404" ]; then break; fi
  sleep 2
done

echo "==> creating local owner account (ignored if one exists)"
curl -s -X POST http://localhost:5678/rest/owner/setup \
  -H 'content-type: application/json' \
  -d "{\"email\":\"${N8N_OWNER_EMAIL:-it-admin@example.com}\",\"firstName\":\"${N8N_OWNER_FIRST_NAME:-IT}\",\"lastName\":\"${N8N_OWNER_LAST_NAME:-Admin}\",\"password\":\"${N8N_OWNER_PASSWORD:-ChangeMe12345!}\"}" \
  | head -c 200
echo
echo
echo "n8n editor : http://localhost:5678  (${N8N_OWNER_EMAIL:-it-admin@example.com} / ${N8N_OWNER_PASSWORD:-ChangeMe12345!})"
echo "health     : curl http://localhost:5678/healthz"
echo "ticket     : node scripts/send-ticket.mjs sara.khan \"Need VS Code installed\""
echo "helpdesk   : curl -H 'x-api-key: $HELPDESK_API_KEY' http://localhost:8080/tickets"
