#!/usr/bin/env bash
# Example test: capture via curl (mode headers) then replay via softprobe diff.
# 1. Start the app (no mode = header-driven); curl GET / with capture headers; curl /flush.
# 2. Start the app in REPLAY with the cassette; run softprobe diff; exit with CLI exit code.
#
# Run from repo root: npm run example:test
# Prerequisites: docker compose up (Postgres + Redis) for the capture phase.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PORT="${PORT:-3010}"
CASSETTE="$SCRIPT_DIR/softprobe-test.ndjson"
CASSETTE_REL="./softprobe-test.ndjson"

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Phase 1: capture — start server, one request with capture headers, flush
cd "$SCRIPT_DIR"
export PORT="$PORT"
npx ts-node --transpile-only -r ./instrumentation.ts run.ts &
SERVER_PID=$!

# wait for server
for i in $(seq 1 30); do
  if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/ping" | grep -q 200; then
    break
  fi
  [ $i -eq 30 ] && { echo "Server did not start"; exit 1; }
  sleep 0.5
done

curl -s -H "x-softprobe-mode: CAPTURE" \
     -H "x-softprobe-cassette-path: $CASSETTE_REL" \
     "http://127.0.0.1:$PORT/" > /dev/null
curl -s "http://127.0.0.1:$PORT/flush" > /dev/null
kill $SERVER_PID 2>/dev/null || true
SERVER_PID=
wait 2>/dev/null || true
sleep 1

[ ! -f "$CASSETTE" ] && { echo "Cassette not created: $CASSETTE"; exit 1; }

# Phase 2: replay — start server in REPLAY, run softprobe diff
# Free port so the replay server (not a stale one) handles the diff request
lsof -ti ":$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

SOFTPROBE_MODE=REPLAY SOFTPROBE_STRICT_REPLAY=1 SOFTPROBE_CASSETTE_PATH="$CASSETTE" \
  npx ts-node --transpile-only -r ./instrumentation.ts run.ts &
SERVER_PID=$!

for i in $(seq 1 30); do
  if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/ping" | grep -q 200; then
    break
  fi
  [ $i -eq 30 ] && { echo "Replay server did not start"; exit 1; }
  sleep 0.5
done

# Run softprobe CLI diff (from repo root)
cd "$REPO_ROOT"
"$REPO_ROOT/bin/softprobe" diff "$CASSETTE" "http://127.0.0.1:$PORT"
exit $?
