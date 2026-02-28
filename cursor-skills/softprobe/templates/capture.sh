#!/usr/bin/env bash
set -euo pipefail

# Usage:
# TRACE_ID=11111111111111111111111111111111 \
# TARGET_URL=http://127.0.0.1:3000 \
# ROUTE='/price?sku=coffee-beans' \
# softprobe capture "${TARGET_URL}${ROUTE}" --trace-id "$TRACE_ID"

: "${TRACE_ID:?TRACE_ID is required}"
: "${TARGET_URL:?TARGET_URL is required}"
: "${ROUTE:?ROUTE is required}"

CMD=(softprobe capture "${TARGET_URL}${ROUTE}" --trace-id "$TRACE_ID" --method "${METHOD:-GET}")
if [ -n "${DATA:-}" ]; then
  CMD+=(--data "$DATA")
fi
"${CMD[@]}"
