# Basic-app example

This example shows how to use **Softprobe** for record & replay: add `softprobe/init` to your app, capture traffic via HTTP headers, and replay it with the `softprobe diff` CLI.

## Run the example end-to-end

From the **repository root**:

```bash
npm run example:up      # start Postgres + Redis (Docker)
npm run example:capture # capture one request → writes examples/basic-app/softprobe-cassettes.ndjson
npm run example:replay-then-diff   # start REPLAY server, run diff, exit 0 = pass
```

Then stop services: `npm run example:down`.

**One-shot test** (capture + replay + diff in one script):

```bash
npm run example:up
npm run example:test    # capture → REPLAY server → diff; exit code = test result
npm run example:down
```

---

## How it works

1. **Softprobe runs first** — Your app loads `softprobe/init` before OpenTelemetry (see `instrumentation.ts`). That enables capture and replay and patches Express so the Softprobe middleware is applied automatically.

2. **Capture** — A request with **capture headers** is recorded into an NDJSON cassette (inbound + outbound Postgres, Redis, HTTP). `example:capture` does this; or use curl with `x-softprobe-mode: CAPTURE` and `x-softprobe-cassette-path`, then `/flush`.

3. **Replay and diff** — The **server must be in REPLAY mode** (so fetch/Postgres/Redis are mocked). `softprobe diff <cassette> <url>` sends the recorded request with replay headers; the server responds from the cassette. The CLI exits 0 if the response matches the recording. Use `npm run example:replay-then-diff` so the server is started in REPLAY and diff runs against it.

## What’s in this example

| File | Purpose |
|------|--------|
| `instrumentation.ts` | Load `softprobe/init` first, then OpenTelemetry. Used via `-r ./instrumentation.ts`. |
| `run.ts` | Demo app: Express with Postgres, Redis, and outbound HTTP. Uses `require('express')` so Softprobe middleware is injected. |
| `test-with-capture-replay.sh` | One-shot: capture → REPLAY server → `softprobe diff` (used by `example:test`). |
| `replay-and-diff.sh` | Start app in REPLAY with cassette, run `softprobe diff`, exit with diff code (used by `example:replay-then-diff`). |
| `capture-runner.ts` | Starts app in CAPTURE, hits `/` and `/exit` (used by `example:capture`). |
| `replay-runner.ts` | Starts app in REPLAY and hits `/` once (optional; for diff use `example:replay-then-diff`). |

All commands are run from the **repository root** unless noted.

### Why the diff tool can fail (Traceparent / span id mismatch)

If you see `softprobe diff: FAIL` with only `http.headers.Traceparent` (and maybe `X-Amzn-Trace-Id`) differing, the live response is using the **outbound** recorded body instead of the **inbound** one.

1. **Run the diff from the repository root**  
   The CLI resolves the cassette path with `path.resolve(process.cwd(), file)`. If you run from `examples/basic-app`, then `examples/basic-app/softprobe-cassettes.ndjson` becomes `.../basic-app/examples/basic-app/softprobe-cassettes.ndjson`, which does not exist. The server then can’t load the right cassette (or the CLI fails to load it). Always run from the repo root, e.g.:
   ```bash
   bin/softprobe diff examples/basic-app/softprobe-cassettes.ndjson http://localhost:3000
   ```
   If the cassette path is wrong, the CLI will report: `Cassette file not found: ... Run the diff from the repository root`.

2. **Use a known-good flow**  
   For a reliable pass, use `npm run example:replay-then-diff` (starts the server in REPLAY with the cassette, then runs the diff) or `npm run example:test` (capture then replay then diff in one script).

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

### 3. Capture via headers (recommended)

The cassette file is **only created** when you (1) send at least one request **with capture headers**, then (2) call `/flush` (or stop the server so it flushes on exit). A plain `GET /` without headers does not record.

With the server still running:

```bash
# 1. Record one request (this triggers capture for that request only)
curl -H "x-softprobe-mode: CAPTURE" \
     -H "x-softprobe-cassette-path: ./softprobe-cassettes.ndjson" \
     http://localhost:3000/

# 2. Flush so the file is written to disk
curl http://localhost:3000/flush
```

**Where the file appears:** The path is relative to the **server’s** current working directory. When you use `npm run example:run`, the server runs from `examples/basic-app`, so the file is created at **`examples/basic-app/softprobe-cassettes.ndjson`**. From the repo root, list it with:

```bash
ls examples/basic-app/softprobe-cassettes.ndjson
```

### 4. Replay and diff

The **server must be in REPLAY mode** for `softprobe diff` to work (fetch, Postgres, and Redis are mocked from the cassette). Easiest: run `npm run example:replay-then-diff` (starts REPLAY server, runs diff, exits with diff code). Create the cassette first (step 3 or `npm run example:capture`).

**Manual:** Start the server in REPLAY, then run the CLI in another terminal **from repo root**:

Manual two-terminal flow:

```bash
# Terminal 1 (cd examples/basic-app)
PORT=3000 SOFTPROBE_MODE=REPLAY SOFTPROBE_CASSETTE_PATH=./softprobe-cassettes.ndjson \
  npx ts-node --transpile-only -r ./instrumentation.ts run.ts
# Terminal 2 (repo root)
./bin/softprobe diff examples/basic-app/softprobe-cassettes.ndjson http://localhost:3000
```

**If you see `ENOENT: no such file or directory` or “No such file”** — create the cassette first (step 3 or `npm run example:capture`).

### Optional: env-based capture script

You can also record one run without curl by using the capture runner (app starts with `SOFTPROBE_MODE=CAPTURE`, hits `/` and `/exit`):

```bash
npm run example:capture
```

This writes `examples/basic-app/softprobe-cassettes.ndjson`. Then run `npm run example:replay-then-diff` from repo root.

### Stop the example app and free ports

If the app is running in the foreground, press **Ctrl+C**. If you started it in the background or lost the terminal:

```bash
# From repo root: kill whatever is on the example ports (3000 and 3010)
npm run example:kill
```

Then start again with `npm run example:run`.

**Many node processes?** E2E tests spawn worker processes (`express-inbound-worker`, `fastify-inbound-worker`, etc.). If tests were interrupted or crashed, those workers can stay running. To kill them:

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
| Record a request | Send the request with `x-softprobe-mode: CAPTURE` and `x-softprobe-cassette-path: <path>`. Call `/flush` (or your flush endpoint) so the cassette is written. |
| Replay and compare | Run your server with `SOFTPROBE_MODE=REPLAY` and `SOFTPROBE_CASSETTE_PATH=<path>`. Run `softprobe diff <cassette.ndjson> <targetUrl>`. |

See the main [Softprobe README](../../README.md) and [design.md](../../design.md) for more on the cassette format and coordination headers.
