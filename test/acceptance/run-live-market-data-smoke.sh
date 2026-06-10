#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${PORT:-3200}"
BASE_URL="http://127.0.0.1:$PORT"
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-2}"
CURL_MAX_TIME="${CURL_MAX_TIME:-10}"
API_PID=""

fail() {
  printf 'live market-data smoke test failed: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command '$1' is not available"
}

assert_disposable_database_acknowledged() {
  [[ "${LIVE_SMOKE_CONFIRM_DISPOSABLE_DATABASE:-}" == "true" ]] || fail "refusing to reset database; set LIVE_SMOKE_CONFIRM_DISPOSABLE_DATABASE=true only when DATABASE_URL points at a disposable Postgres database"

  DATABASE_URL="$DATABASE_URL" node <<'NODE'
try {
  const url = new URL(process.env.DATABASE_URL);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) {
    throw new Error("database name is empty");
  }
  if (["postgres", "template0", "template1"].includes(database)) {
    throw new Error(`database '${database}' is not an acceptable disposable application database`);
  }
  console.log(`Live smoke database reset acknowledged for ${url.hostname}/${database}`);
} catch (error) {
  console.error(`Invalid DATABASE_URL for live market-data smoke test: ${error.message}`);
  process.exit(1);
}
NODE
}

assert_port_available() {
  HOST="127.0.0.1" PORT="$PORT" node <<'NODE'
const net = require("net");
const host = process.env.HOST;
const port = Number(process.env.PORT);
const socket = net.createConnection({ host, port });

socket.setTimeout(1000);
socket.once("connect", () => {
  socket.destroy();
  console.error(`Port ${port} is already accepting connections on ${host}; choose a free PORT for live smoke tests`);
  process.exit(1);
});
socket.once("timeout", () => {
  socket.destroy();
  process.exit(0);
});
socket.once("error", (error) => {
  if (error.code === "ECONNREFUSED") {
    process.exit(0);
  }
  console.error(`Unable to verify port ${port} availability: ${error.message}`);
  process.exit(1);
});
NODE
}

curl_with_timeouts() {
  curl --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" "$@"
}

cleanup() {
  local status=$?
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" >/dev/null 2>&1; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

[[ -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL must point at a disposable Postgres database"

require_command curl
require_command node
require_command npm
assert_disposable_database_acknowledged
assert_port_available

printf 'Building API and worker...\n'
(cd "$ROOT_DIR" && npm run build)

printf 'Running migrations against disposable database...\n'
(cd "$ROOT_DIR" && npm run db:migrate)

printf 'Running one read-only scanner pass against live public market data...\n'
(
  cd "$ROOT_DIR"
  NODE_ENV=test \
    DATABASE_URL="$DATABASE_URL" \
    VENUE_HTTP_TIMEOUT_MS="${VENUE_HTTP_TIMEOUT_MS:-15000}" \
    VENUE_HTTP_RETRIES="${VENUE_HTTP_RETRIES:-4}" \
    VENUE_HTTP_RETRY_DELAY_MS="${VENUE_HTTP_RETRY_DELAY_MS:-250}" \
    VENUE_HTTP_VERBOSE="${VENUE_HTTP_VERBOSE:-true}" \
    node dist/src/main-worker.js
)

printf 'Starting API on port %s...\n' "$PORT"
NODE_ENV=test PORT="$PORT" DATABASE_URL="$DATABASE_URL" node "$ROOT_DIR/dist/src/main-api.js" &
API_PID=$!

for _ in $(seq 1 60); do
  if ! kill -0 "$API_PID" >/dev/null 2>&1; then
    wait "$API_PID" || true
    fail "API process exited before becoming healthy"
  fi
  if curl_with_timeouts -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

kill -0 "$API_PID" >/dev/null 2>&1 || fail "API process exited after readiness probe"
curl_with_timeouts -fsS "$BASE_URL/health" >/dev/null 2>&1 || fail "API did not become healthy at $BASE_URL/health"

request_json() {
  local path="$1"
  local body_file status
  body_file="$(mktemp)"
  status="$(curl_with_timeouts -sS -o "$body_file" -w '%{http_code}' "$BASE_URL$path")" || {
    rm -f "$body_file"
    fail "GET $path curl request failed"
  }

  if [[ "$status" != "200" ]]; then
    printf 'Response body for GET %s:\n' "$path" >&2
    node -e 'const fs = require("fs"); process.stderr.write(fs.readFileSync(process.argv[1], "utf8") + "\n");' "$body_file"
    rm -f "$body_file"
    fail "GET $path expected HTTP 200, got $status"
  fi

  printf '%s' "$body_file"
}

latest_scan_file="$(request_json /v1/scan-runs/latest)"
markets_file="$(request_json /v1/markets)"

node - "$latest_scan_file" "$markets_file" <<'NODE'
const fs = require("fs");
const latestScan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const markets = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(latestScan.status === "succeeded", `expected latest live scan to succeed, got ${latestScan.status}`);
assert(typeof latestScan.id === "string" && latestScan.id.length > 0, "expected latest scan id");
assert(typeof latestScan.startedAt === "string", "expected latest scan startedAt ISO string");
assert(Number.isInteger(latestScan.marketsScanned), "expected marketsScanned integer");
assert(Number.isInteger(latestScan.opportunitiesFound), "expected opportunitiesFound integer");
assert(Array.isArray(markets), "expected /v1/markets array");

if (latestScan.marketsScanned > 0) {
  assert(markets.length > 0, "expected /v1/markets to reflect persisted live market data when the scanner saw markets");
}

console.log(`ok live scan ${latestScan.id}: marketsScanned=${latestScan.marketsScanned}, apiMarkets=${markets.length}, opportunitiesFound=${latestScan.opportunitiesFound}`);
NODE

rm -f "$latest_scan_file" "$markets_file"
printf 'Live market-data smoke test passed.\n'
