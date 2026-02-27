# Basic-app example

This example shows how to use **Softprobe** for record & replay: add `softprobe/init` to your app, capture traffic via HTTP headers, and replay it with the `softprobe diff` CLI.

**Configuration:** Mode and cassette directory come from **YAML config only**. Do not use `SOFTPROBE_MODE`, `SOFTPROBE_CASSETTE_PATH`, or `SOFTPROBE_CASSETTE_DIRECTORY`. The app reads `./.softprobe/config.yml` by default, or the path in `SOFTPROBE_CONFIG_PATH`.

---

## Canonical flow

One intended way to run the example:

1. **Start the app with YAML `mode: CAPTURE` and `cassetteDirectory`**  
   Use the example config under `.softprobe/config.yml` (mode: CAPTURE, cassetteDirectory: "."). Start the app so it loads that config (e.g. run from `examples/basic-app` so default `./.softprobe/config.yml` is used, or set `SOFTPROBE_CONFIG_PATH`).

2. **Capture request writes cassette**  
   Send at least one request with capture headers (`x-softprobe-mode: CAPTURE`, `x-softprobe-trace-id: <id>`), then call `/flush`. The server writes one file per trace: `{cassetteDirectory}/{traceId}.ndjson`.

3. **Replay test uses `softprobe diff` (request switched to REPLAY via headers)**  
   Run `softprobe diff <cassetteFile> <url>`. The CLI sends the request with replay headers (`x-softprobe-mode: REPLAY`, `x-softprobe-trace-id`). The server that receives this request must have `cassetteDirectory` set (same as capture) and be running in a mode that supports replay (e.g. **PASSTHROUGH** or REPLAY from YAML). So either:
   - Restart the app with a YAML that has `mode: PASSTHROUGH` (or REPLAY) and the same `cassetteDirectory`, then run diff, or  
   - Use `.softprobe/config-passthrough.yml` from the start: one server handles both capture (via headers) and replay (diff sends REPLAY headers).

---

## Run the example end-to-end

From the **repository root**:

```bash
npm run example:up      # start Postgres + Redis (Docker)
npm run example:capture # capture one request → writes cassette under examples/basic-app (per traceId)
npm run example:replay-then-diff   # start server with replay-capable config, run diff, exit 0 = pass
```

Then stop services: `npm run example:down`.

**One-shot test** (capture + replay + diff in one script):

```bash
npm run example:up
npm run example:test    # capture → replay server → diff; exit code = test result
npm run example:down
```

---

## How it works

1. **Softprobe runs first** — Your app loads `softprobe/init` before OpenTelemetry (see `instrumentation.ts`). Init reads the YAML config (mode, cassetteDirectory). That enables capture/replay and patches Express so the Softprobe middleware is applied automatically.

2. **Capture** — A request with **capture headers** (`x-softprobe-mode: CAPTURE`, `x-softprobe-trace-id: <id>`) is recorded into NDJSON (inbound + outbound Postgres, Redis, HTTP). The server writes to `{cassetteDirectory}/{traceId}.ndjson`. Call `/flush` so the cassette is written to disk.

3. **Replay and diff** — `softprobe diff <cassette> <url>` loads the cassette, finds the inbound record, and sends the same request to the target URL with **replay headers** (`x-softprobe-mode: REPLAY`, `x-softprobe-trace-id`). The server handles that request in REPLAY (mocked fetch/Postgres/Redis from the cassette). The CLI exits 0 if the response matches the recording. The server must have `cassetteDirectory` set (from YAML) and be in a mode that supports replay (PASSTHROUGH or REPLAY from config).

## What’s in this example

| File | Purpose |
|------|---------|
| `.softprobe/config.yml` | Example YAML: `mode: CAPTURE`, `cassetteDirectory: "."`. Used when running from this directory. |
| `.softprobe/config-passthrough.yml` | Optional: `mode: PASSTHROUGH`, same cassetteDirectory — one server for both capture and replay via headers. |
| `instrumentation.ts` | Load `softprobe/init` first, then OpenTelemetry. Used via `-r ./instrumentation.ts`. |
| `run.ts` | Demo app: Express with Postgres, Redis, and outbound HTTP. Uses `require('express')` so Softprobe middleware is injected. |
| `test-with-capture-replay.sh` | One-shot: capture → replay server → `softprobe diff` (used by `example:test`). |
| `replay-and-diff.sh` | Start app with replay-capable config, run `softprobe diff`, exit with diff code (used by `example:replay-then-diff`). |
| `capture-runner.ts` | Starts app with CAPTURE config, hits `/` and `/exit` (used by `example:capture`). |
| `replay-runner.ts` | Starts app in REPLAY and hits `/` once (optional; for diff use `example:replay-then-diff`). |

All commands are run from the **repository root** unless noted.

### Why the diff tool can fail (Traceparent / span id mismatch)

If you see `softprobe diff: FAIL` with only `http.headers.Traceparent` (and maybe `X-Amzn-Trace-Id`) differing, the live response is using the **outbound** recorded body instead of the **inbound** one.

1. **Run the diff from the repository root**  
   The CLI resolves the cassette path with `path.resolve(process.cwd(), file)`. If you run from `examples/basic-app`, then `examples/basic-app/softprobe-cassettes.ndjson` becomes `.../basic-app/examples/basic-app/softprobe-cassettes.ndjson`, which does not exist. Always run from the repo root, e.g.:
   ```bash
   bin/softprobe diff examples/basic-app/softprobe-cassettes.ndjson http://localhost:3000
   ```
   If the cassette path is wrong, the CLI will report: `Cassette file not found: ... Run the diff from the repository root`.

2. **Use the canonical flow**  
   Ensure the app is started with a YAML config that sets `cassetteDirectory` (and, for replay, a mode that supports replay). Use `npm run example:replay-then-diff` or `npm run example:test` for a known-good flow.

---

## Full app (Postgres, Redis, HTTP)

The main demo is `run.ts`: one route that talks to Postgres, Redis, and httpbin.org.

### Prerequisites

- Node.js (dependencies installed at repo root: `npm install`)
- Docker (for Postgres and Redis)

### 1. Start Postgres and Redis

```bash
npm run example:up
```

### 2. Run the app

```bash
npm run example:run
```

Then open or curl `http://localhost:3000/` — you get JSON with `postgres`, `redis`, and `http` fields.

### 3. Capture via headers (canonical)

The cassette file is **only created** when you (1) send at least one request **with capture headers**, then (2) call `/flush` (or stop the server so it flushes on exit). A plain `GET /` without headers does not record.

Start the app with the example YAML (e.g. from `examples/basic-app` so `./.softprobe/config.yml` is used, or set `SOFTPROBE_CONFIG_PATH`). With the server running:

```bash
# 1. Record one request (trace-id becomes filename: {cassetteDirectory}/{trace-id}.ndjson)
curl -H "x-softprobe-mode: CAPTURE" \
     -H "x-softprobe-trace-id: softprobe-cassettes" \
     http://localhost:3000/

# 2. Flush so the file is written to disk
curl http://localhost:3000/flush
```

**Where the file appears:** The path is `{cassetteDirectory}/{traceId}.ndjson`, with `cassetteDirectory` from the YAML config (e.g. "." so `examples/basic-app/softprobe-cassettes.ndjson` when run from that directory).

### 4. Replay and diff

Run `softprobe diff` **from the repository root**. The CLI sends the request with replay headers; the server must have `cassetteDirectory` set (from YAML) and be in a mode that supports replay (PASSTHROUGH or REPLAY from config). Easiest: `npm run example:replay-then-diff` (starts server with replay-capable config, runs diff, exits with diff code). Create the cassette first (step 3 or `npm run example:capture`).

**Manual two-terminal flow** (use YAML for mode and cassetteDirectory, not env vars):

```bash
# Terminal 1 (cd examples/basic-app) — use a config with mode: PASSTHROUGH or REPLAY and cassetteDirectory: "."
SOFTPROBE_CONFIG_PATH=./.softprobe/config-passthrough.yml \
  npx ts-node --transpile-only -r ./instrumentation.ts run.ts
# Terminal 2 (repo root)
./bin/softprobe diff examples/basic-app/softprobe-cassettes.ndjson http://localhost:3000
```

**If you see `ENOENT: no such file or directory` or “No such file”** — create the cassette first (step 3 or `npm run example:capture`).

### Optional: capture runner

You can also record one run using the capture runner (app starts with CAPTURE config, hits `/` and `/exit`):

```bash
npm run example:capture
```

This writes a cassette under `examples/basic-app/` (one file per traceId). Then run `npm run example:replay-then-diff` from repo root.

### Stop the example app and free ports

If the app is running in the foreground, press **Ctrl+C**. If you started it in the background or lost the terminal:

```bash
# From repo root: kill whatever is on the example ports (3000 and 3010)
npm run example:kill
```

Then start again with `npm run example:run`.

**Many node processes?** E2E tests spawn worker processes. If tests were interrupted or crashed, those workers can stay running. To kill them:

```bash
npm run example:kill-e2e
```

### Stop services (Docker)

```bash
npm run example:down
```

---

## Summary

| Goal | What to do |
|------|------------|
| Add Softprobe to your app | Import `softprobe/init` first (e.g. in `instrumentation.ts`), then load OTel. Use `require('express')` so middleware is injected. |
| Configure mode and cassette | Use a YAML config (default `./.softprobe/config.yml` or `SOFTPROBE_CONFIG_PATH`). Set `mode` and `cassetteDirectory`. Do not use `SOFTPROBE_MODE` or `SOFTPROBE_CASSETTE_PATH` / `SOFTPROBE_CASSETTE_DIRECTORY`. |
| Record a request | Send the request with `x-softprobe-mode: CAPTURE` and `x-softprobe-trace-id: <id>`. Server writes to `{cassetteDirectory}/{id}.ndjson`. Call `/flush` so the cassette is written. |
| Replay and compare | Start the server with a YAML that has `cassetteDirectory` and a mode that supports replay (PASSTHROUGH or REPLAY). Run `softprobe diff <cassette.ndjson> <targetUrl>` from the repo root; the CLI sends replay headers so the server handles that request in REPLAY. |

See the main [Softprobe README](../../README.md), [design.md](../../design.md), [design-context.md](../../design-context.md), [design-cassette.md](../../design-cassette.md), and [design-matcher.md](../../design-matcher.md) for more on cassette format and coordination headers.
