#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SEED_SQL="$ROOT_DIR/test/acceptance/seed.sql"
PORT="${PORT:-3100}"
BASE_URL="http://127.0.0.1:$PORT"
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-2}"
CURL_MAX_TIME="${CURL_MAX_TIME:-10}"
API_PID=""

fail() {
  printf 'acceptance test failed: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command '$1' is not available"
}

assert_disposable_database_acknowledged() {
  [[ "${ACCEPTANCE_CONFIRM_DISPOSABLE_DATABASE:-}" == "true" ]] || fail "refusing to reset database; set ACCEPTANCE_CONFIRM_DISPOSABLE_DATABASE=true only when DATABASE_URL points at a disposable Postgres database"

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
  console.log(`Database reset acknowledged for ${url.hostname}/${database}`);
} catch (error) {
  console.error(`Invalid DATABASE_URL for acceptance tests: ${error.message}`);
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
  console.error(`Port ${port} is already accepting connections on ${host}; choose a free PORT for acceptance tests`);
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
[[ -f "$SEED_SQL" ]] || fail "seed file not found: $SEED_SQL"

require_command curl
require_command node
require_command npm
assert_disposable_database_acknowledged
assert_port_available

printf 'Building API...\n'
(cd "$ROOT_DIR" && npm run build)

printf 'Running migrations against disposable database...\n'
(cd "$ROOT_DIR" && npm run db:migrate)

printf 'Seeding deterministic data...\n'
DATABASE_URL="$DATABASE_URL" node - "$SEED_SQL" <<'NODE'
const fs = require("fs");
const { Client } = require("pg");

const seedFile = process.argv[2];
const sql = fs.readFileSync(seedFile, "utf8");
const client = new Client({ connectionString: process.env.DATABASE_URL });

client.connect()
  .then(() => client.query(sql))
  .then(() => client.end())
  .catch(async (error) => {
    console.error(`Failed to seed database from ${seedFile}:`);
    console.error(error.message);
    try {
      await client.end();
    } catch (_) {
      // Ignore cleanup errors after connection/query failure.
    }
    process.exit(1);
  });
NODE

printf 'Starting API on port %s...\n' "$PORT"
NODE_ENV=test PORT="$PORT" DATABASE_URL="$DATABASE_URL" node "$ROOT_DIR/dist/main-api.js" &
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

request() {
  local method="$1"
  local path="$2"
  local expected_status="$3"
  local assertion_name="$4"
  local body_file status
  body_file="$(mktemp)"
  status="$(curl_with_timeouts -sS -X "$method" -o "$body_file" -w '%{http_code}' "$BASE_URL$path")" || {
    rm -f "$body_file"
    fail "$method $path curl request failed"
  }

  if [[ "$status" != "$expected_status" ]]; then
    printf 'Response body for %s %s:\n' "$method" "$path" >&2
    node -e 'const fs = require("fs"); process.stderr.write(fs.readFileSync(process.argv[1], "utf8") + "\n");' "$body_file"
    rm -f "$body_file"
    fail "$method $path expected HTTP $expected_status, got $status"
  fi

  if ! ASSERTION="$assertion_name" node - "$body_file" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const assertion = process.env.ASSERTION;
const raw = fs.readFileSync(file, "utf8");
let data;
try {
  data = raw.length ? JSON.parse(raw) : null;
} catch (error) {
  console.error(`Invalid JSON for ${assertion}: ${raw}`);
  throw error;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`${assertion}: ${message}\nBody: ${JSON.stringify(data, null, 2)}`);
  }
}

const opportunityId = "00000000-0000-4000-8000-000000000401";
const missingOpportunityId = "00000000-0000-4000-8000-000000009999";

switch (assertion) {
  case "health":
    assert(data.status === "ok", "expected status ok");
    break;
  case "markets":
    assert(Array.isArray(data), "expected array");
    assert(data.length === 2, "expected two markets");
    assert(data[0].venue === "polymarket", "expected newest market first");
    assert(data[0].venueMarketId === "P1", "expected polymarket venueMarketId P1");
    assert(data[0].threshold === 100000, "expected numeric threshold");
    assert(data[0].confidence === 0.93, "expected numeric confidence");
    assert(data[1].venue === "kalshi", "expected second market to be kalshi");
    assert(data[1].ambiguityFlags.length === 0, "expected empty ambiguity flags");
    break;
  case "opportunities":
    assert(Array.isArray(data), "expected array");
    assert(data.length === 1, "expected one opportunity");
    assert(data[0].id === opportunityId, "expected seeded opportunity id");
    assert(data[0].pairId === "00000000-0000-4000-8000-000000000201", "expected seeded pair id");
    assert(data[0].combinedCost === 0.93, "expected combinedCost 0.93");
    assert(data[0].netEdge === 0.055, "expected netEdge 0.055");
    assert(data[0].longLeg.venue === "kalshi", "expected kalshi long leg");
    assert(data[0].hedgeLeg.side === "NO", "expected NO hedge leg");
    assert(data[0].kalshiOrderbookSnapshotId === "00000000-0000-4000-8000-000000000301", "expected kalshi snapshot provenance");
    assert(data[0].polymarketOrderbookSnapshotId === "00000000-0000-4000-8000-000000000302", "expected polymarket snapshot provenance");
    break;
  case "opportunityById":
    assert(data.id === opportunityId, "expected seeded opportunity id");
    assert(data.maxTradableUsd === 12, "expected maxTradableUsd 12");
    assert(data.resolutionRisk === "low", "expected low resolution risk");
    assert(data.fillRisk === "medium", "expected medium fill risk");
    assert(data.detectedAt === "2026-06-03T12:00:01.000Z", "expected detectedAt ISO string");
    break;
  case "malformedId":
    assert(data.statusCode === 400, "expected statusCode 400");
    assert(data.message === "Opportunity id must be a UUID", "expected readable malformed UUID message");
    break;
  case "missingUuid":
    assert(data.statusCode === 404, "expected statusCode 404");
    assert(data.message === `Opportunity ${missingOpportunityId} not found`, "expected readable missing UUID message");
    break;
  case "latestScanRun":
    assert(data.id === "00000000-0000-4000-8000-000000000001", "expected latest scan run id");
    assert(data.status === "succeeded", "expected succeeded scan run");
    assert(data.startedAt === "2026-06-03T11:59:59.000Z", "expected startedAt ISO string");
    assert(data.completedAt === "2026-06-03T12:00:01.000Z", "expected completedAt ISO string");
    assert(data.marketsScanned === 2, "expected marketsScanned 2");
    assert(data.opportunitiesFound === 1, "expected opportunitiesFound 1");
    break;
  default:
    throw new Error(`Unknown assertion ${assertion}`);
}
NODE
  then
    rm -f "$body_file"
    fail "$method $path response assertion failed"
  fi

  rm -f "$body_file"
  printf 'ok %s %s -> %s\n' "$method" "$path" "$expected_status"
}

request GET /health 200 health
request GET /v1/markets 200 markets
request GET /v1/opportunities 200 opportunities
request GET /v1/opportunities/00000000-0000-4000-8000-000000000401 200 opportunityById
request GET /v1/opportunities/not-a-uuid 400 malformedId
request GET /v1/opportunities/00000000-0000-4000-8000-000000009999 404 missingUuid
request GET /v1/scan-runs/latest 200 latestScanRun

printf 'Acceptance tests passed.\n'
