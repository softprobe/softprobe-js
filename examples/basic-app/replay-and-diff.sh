#!/usr/bin/env bash
# Start the app with replay-capable YAML (PASSTHROUGH + cassetteDirectory), run softprobe diff, exit with diff code.
# Run from repo root after you have a cassette: npm run example:replay-then-diff
# Cassette: examples/basic-app/softprobe-cassettes.ndjson (create with npm run example:capture or use canonical flow).

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PORT="${PORT:-3000}"
CASSETTE="$SCRIPT_DIR/softprobe-cassettes.ndjson"
CASSETTE_FROM_ROOT="examples/basic-app/$(basename "$CASSETTE")"

[ ! -f "$CASSETTE" ] && { echo "Cassette not found: $CASSETTE. Run: npm run example:capture or npm run example:test"; exit 1; }

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

cd "$SCRIPT_DIR"
export PORT="$PORT"
export SOFTPROBE_CONFIG_PATH="$SCRIPT_DIR/.softprobe/config-passthrough.yml"
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
"$REPO_ROOT/bin/softprobe" diff "$CASSETTE_FROM_ROOT" "http://127.0.0.1:$PORT"
exit $?
