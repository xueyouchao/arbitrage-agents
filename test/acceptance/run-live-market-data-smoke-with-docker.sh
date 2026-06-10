#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

CONTAINER="${LIVE_SMOKE_POSTGRES_CONTAINER:-arb-live-smoke-postgres}"
DB_PORT="${LIVE_SMOKE_POSTGRES_PORT:-55433}"
DB_NAME="${LIVE_SMOKE_POSTGRES_DB:-arbitrage_live_smoke}"
DB_USER="${LIVE_SMOKE_POSTGRES_USER:-postgres}"
DB_PASS="${LIVE_SMOKE_POSTGRES_PASSWORD:-live_smoke}"
POSTGRES_IMAGE="${LIVE_SMOKE_POSTGRES_IMAGE:-postgres:16-alpine}"
DATABASE_URL="postgres://${DB_USER}:${DB_PASS}@127.0.0.1:${DB_PORT}/${DB_NAME}"

cleanup() {
  local status=$?
  sudo docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || {
  printf 'docker is required for this live smoke wrapper\n' >&2
  exit 1
}

if ! sudo -n docker ps >/dev/null 2>&1; then
  printf 'passwordless sudo docker access is required; try: sudo docker ps\n' >&2
  exit 1
fi

if ss -ltn "sport = :${DB_PORT}" | grep -q ":${DB_PORT}"; then
  printf 'port %s is already in use; set LIVE_SMOKE_POSTGRES_PORT to a free port\n' "$DB_PORT" >&2
  exit 1
fi

sudo docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

printf 'Starting disposable live-smoke Postgres %s on 127.0.0.1:%s/%s...\n' "$POSTGRES_IMAGE" "$DB_PORT" "$DB_NAME"
sudo docker run --rm -d \
  --name "$CONTAINER" \
  -e POSTGRES_PASSWORD="$DB_PASS" \
  -e POSTGRES_DB="$DB_NAME" \
  -p "127.0.0.1:${DB_PORT}:5432" \
  "$POSTGRES_IMAGE" >/dev/null

for attempt in $(seq 1 60); do
  if sudo docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    printf 'Disposable live-smoke Postgres is ready.\n'
    break
  fi

  if [[ "$attempt" -eq 60 ]]; then
    printf 'Disposable live-smoke Postgres did not become ready. Container logs:\n' >&2
    sudo docker logs "$CONTAINER" >&2 || true
    exit 1
  fi

  sleep 1
done

(
  cd "$ROOT_DIR"
  DATABASE_URL="$DATABASE_URL" \
    LIVE_SMOKE_CONFIRM_DISPOSABLE_DATABASE=true \
    npm run test:live-smoke
)
