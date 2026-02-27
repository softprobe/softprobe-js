# Pricing Regression Demo (Manual, Customer-Facing)

This demo shows Softprobe catching a business regression where app v2 returns the wrong price without throwing any error.

## Step 1. Run v1 app (baseline)

From repo root:

```bash
cd examples/pricing-regression-demo
SOFTPROBE_CONFIG_PATH=./.softprobe/config-capture.yml PORT=3020 \
  npx ts-node --transpile-only -r ./instrumentation.ts app-v1.ts
```

In another terminal, confirm the app is up:

```bash
curl -s http://127.0.0.1:3020/ping
```

## Step 2. Use curl to capture a test case

Use a fixed trace id so the cassette path is deterministic.

```bash
TRACE_ID=11111111111111111111111111111111
curl -s \
  -H "x-softprobe-mode: CAPTURE" \
  -H "x-softprobe-trace-id: ${TRACE_ID}" \
  "http://127.0.0.1:3020/price?sku=coffee-beans"
```

Expected baseline body includes `"priceCents":1080`.

Captured file:

```bash
ls -l ./cassettes/${TRACE_ID}.ndjson
```

Stop v1 with `Ctrl+C`.

## Step 3. Run v2 app (introduce pricing bug)

v2 changes only one line: `TAX_RATE` is `0.18` instead of `0.08`, so it returns `1180` cents.

```bash
SOFTPROBE_CONFIG_PATH=./.softprobe/config-passthrough.yml PORT=3020 \
  npx ts-node --transpile-only -r ./instrumentation.ts app-v2.ts
```

## Step 4. Replay captured case and show diff mismatch

From repo root (new terminal):

```bash
npm run diff:dev -- \
  examples/pricing-regression-demo/cassettes/11111111111111111111111111111111.ndjson \
  http://127.0.0.1:3020
```

Expected output shows a body mismatch on `priceCents`, clearly indicating:

- recorded: `1080`
- live: `1180`

This demonstrates regression detection without runtime exceptions.
