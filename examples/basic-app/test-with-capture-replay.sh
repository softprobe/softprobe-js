#!/usr/bin/env bash
# Canonical example flow (Task 12.3): YAML CAPTURE boot, then softprobe diff (replay via headers).
# 1. Start app via SOFTPROBE_CONFIG_PATH (capture YAML with cassetteDirectory).
# 2. Send capture request with trace headers (x-softprobe-mode, x-softprobe-trace-id), then /flush.
# 3. Start app with replay-capable YAML (PASSTHROUGH + cassetteDirectory); run softprobe diff.
# Exit code = diff result (0 = pass).
#
# Run from repo root: npm run example:test
# Starts Postgres + Redis for capture, then stops them before replay so replay uses only the cassette.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PORT="${PORT:-3010}"
TRACE_ID="softprobe-test"
CASSETTE="$SCRIPT_DIR/$TRACE_ID.ndjson"
# Path from repo root for the diff CLI
CASSETTE_FROM_ROOT="examples/basic-app/$TRACE_ID.ndjson"

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Start Postgres + Redis for capture phase
cd "$REPO_ROOT"
docker compose -f examples/basic-app/docker-compose.yml up -d
cd "$SCRIPT_DIR"

# Phase 1: capture — start app with capture YAML, one request with capture headers, flush
cd "$SCRIPT_DIR"
export PORT="$PORT"
export SOFTPROBE_CONFIG_PATH="$SCRIPT_DIR/.softprobe/config.yml"
npx ts-node --transpile-only -r ./instrumentation.ts run.ts &
SERVER_PID=$!

for i in $(seq 1 30); do
  if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/ping" | grep -q 200; then
    break
  fi
  [ $i -eq 30 ] && { echo "Server did not start"; exit 1; }
  sleep 0.5
done

curl -s -H "x-softprobe-mode: CAPTURE" \
     -H "x-softprobe-trace-id: $TRACE_ID" \
     "http://127.0.0.1:$PORT/" > /dev/null
curl -s "http://127.0.0.1:$PORT/flush" > /dev/null
kill $SERVER_PID 2>/dev/null || true
SERVER_PID=
wait 2>/dev/null || true
sleep 1

[ ! -f "$CASSETTE" ] && { echo "Cassette not created: $CASSETTE"; exit 1; }

# Stop Postgres and Redis so replay runs with no external services (proves replay uses only the cassette)
cd "$REPO_ROOT"
docker compose -f examples/basic-app/docker-compose.yml down 2>/dev/null || true
cd "$SCRIPT_DIR"

# Phase 2: replay — start app with replay-capable YAML (PASSTHROUGH + cassetteDirectory), run softprobe diff
lsof -ti ":$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

export SOFTPROBE_CONFIG_PATH="$SCRIPT_DIR/.softprobe/config-passthrough.yml"
export SOFTPROBE_DEBUG_REPLAY="${SOFTPROBE_DEBUG_REPLAY:-}"
npx ts-node --transpile-only -r ./instrumentation.ts run.ts &
SERVER_PID=$!

for i in $(seq 1 30); do
  if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/ping" | grep -q 200; then
    break
  fi
  [ $i -eq 30 ] && { echo "Replay server did not start"; exit 1; }
  sleep 0.5
done

cd "$REPO_ROOT"
# Ignore http.headers so upstream (httpbin) header variance does not fail the test
"$REPO_ROOT/bin/softprobe" diff --ignore-paths "http.headers" "$CASSETTE_FROM_ROOT" "http://127.0.0.1:$PORT"
exit $?
