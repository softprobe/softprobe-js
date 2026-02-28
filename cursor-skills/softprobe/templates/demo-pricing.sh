#!/usr/bin/env bash
set -euo pipefail

# End-to-end demo runbook for examples/pricing-regression-demo.
# 1) run v1 in one terminal: npm run example:pricing:v1
# 2) run capture:
TRACE_ID="11111111111111111111111111111111"
softprobe capture "http://127.0.0.1:3020/price?sku=coffee-beans" --trace-id "$TRACE_ID"
# 3) stop v1 and run v2: npm run example:pricing:v2
# 4) run diff:
softprobe diff "examples/pricing-regression-demo/cassettes/${TRACE_ID}.ndjson" "http://127.0.0.1:3020"
