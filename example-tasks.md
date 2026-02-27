
---
# 16) User-Facing Example App — CLI + HTTP Headers (v5.2)

**Typical user flow (capture and replay via CLI and headers):**
1. Add `softprobe/init` to their Express (or Fastify) app and use Softprobe middleware.
2. Send a request with **capture mode headers** (`x-softprobe-mode: CAPTURE`, `x-softprobe-trace-id: <id>`) to generate an NDJSON cassette file (server uses cassetteDirectory + traceId).
3. Use the **softprobe CLI** to replay that file against the server: `softprobe diff <cassette.ndjson> <targetUrl>` (CLI sends the request with replay headers; server responds from the cassette).

* [x] **Task 16.1.1 Scaffold `examples/basic-app`** *(feat: minimal Express app with PG/Redis/HTTP; softprobe/init + middleware for header-driven capture/replay)*
* [x] **Task 16.1.2 HTTP for demo** *(feat: outbound HTTP e.g. httpbin so cassette includes HTTP records)*
* [x] **Task 16.1.3 Provide docker-compose** *(feat: Postgres + Redis for local run; optional for replay since CLI replays without live deps)*
* [ ] **Task 16.2.1 Example app: demonstrate capture via headers**
* **User-facing**: Start app (with softprobe/init + middleware); send a request with `x-softprobe-mode: CAPTURE` and `x-softprobe-trace-id`; cassette file is written at `{cassetteDirectory}/{traceId}.ndjson` with inbound (and outbound) records.
* **Note**: Env-based capture-runner script exists (historical); this task is the header-based capture flow as the primary demo.
* **Test**: App running as HTTP server; one request with capture headers → cassette exists and contains inbound record.
* [ ] **Task 16.3.1 Example app: demonstrate replay via CLI**
* **User-facing**: App runs as HTTP server; user captures with headers, then runs `softprobe diff` against the server.
* **Behavior**: (1) Start app with `softprobe/init` and middleware. (2) `curl` (or similar) with `x-softprobe-mode: CAPTURE` and `x-softprobe-trace-id` to record (server uses cassetteDirectory + traceId). (3) `softprobe diff ./softprobe-cassettes.ndjson http://localhost:PORT` replays and compares. Optional: stop DB/Redis to show replay works without live deps.
* **Test**: Record via capture headers → cassette has inbound; run `softprobe diff` → exit 0 and response matches recorded (or E2E asserts CLI receives expected response).

* [ ] **Task 16.4.1 Example app: document or demonstrate custom matcher (optional)**
* **User-facing**: When the server handles a replay request (from CLI or tests), custom matchers can be used via `softprobe.run({ mode, storage, traceId }, async () => { ... })` / `getActiveMatcher().use(...)` in tests or in app code.
* **Test**: `custom-matcher.ts` (or test) uses `softprobe.run({ mode: 'REPLAY', storage, traceId }, async () => { ... })` and matcher override; verify behavior.

---

# 20) User-Facing Example App + Record/Replay Demo — Atomic

**Goal:** Provide a runnable, **customer-visible demo** showing:
- A **normal** example app with **real** connections to **Postgres**, **Redis**, and outbound **HTTP** (e.g. httpbin.org). Users run dependencies via **Docker** (docker-compose); the app is the kind of code a customer would write.
- **Record** real traffic into an NDJSON cassette file.
- **Replay** the same scenario in a test with **no live dependencies**.
- A **custom matcher** example that gives the customer finer control than default matching.

> Keep this example minimal and boring on purpose: clarity > cleverness.
> The example must be a **user-facing demo**: real Postgres/Redis (Docker), normal app code, usable as:
> - `examples/basic-app/` (source)
> - `docker compose up -d` then `npm run example:run`
> - `npm run example:capture` / `npm run example:replay`
> - `npm test` (or `npm run example:test`)

## 20.1 Example app skeleton (no Softprobe yet)
- [x] Task 20.1.1 Scaffold `examples/basic-app` with a single entry script *(feat: examples/basic-app/run.ts + basic-app-example.e2e.test)*
  - **User-facing**: normal app with real Postgres + Redis + HTTP. Default env points at local Docker (docker-compose); no mocks in the app itself.
  - App behavior (single request/flow):
    1) Insert/select from Postgres (or select-only if easier)
    2) Read/write Redis cache
    3) Call an HTTP service (e.g. httpbin.org or local stub)
    4) Return a JSON response containing all three results
  - Test: `node examples/basic-app/run.js` (or ts) exits 0 and prints JSON (E2E can use Testcontainers; demo assumes Docker).

- [x] Task 20.1.2 HTTP for demo: deterministic outbound call *(feat: httpbin.org in run.ts; E2E asserts http.url contains httpbin.org)*
  - Use httpbin.org (or optional local stub) so the example has a deterministic HTTP dependency.
  - Test: app run includes `http` in output; optional `curl` test for stub if used.

- [x] Task 20.1.3 Provide docker-compose for Postgres + Redis (example-only) *(feat: docker-compose.e2e.test.ts; compose already present, test verifies up → run → JSON)*
  - Standard way to run the demo: `docker compose up -d` in examples/basic-app (or repo root); app connects via default PG_URL / REDIS_URL (e.g. localhost).
  - Test: `docker compose up -d` brings services up; `npm run example:run` (or equivalent) connects and prints JSON

## 20.2 Capture demo (record NDJSON)
- [x] Task 20.2.1 Add capture runner script: `npm run example:capture` *(feat: capture-runner.ts, softprobe/init in instrumentation, /exit + flushCapture, example:capture script)*
  - Env:
    - `SOFTPROBE_MODE=CAPTURE`
    - Config with cassetteDirectory (or legacy `SOFTPROBE_CASSETTE_PATH=./softprobe-cassettes.ndjson` when cwd is examples/basic-app; path is converted to directory + traceId)
  - Behavior:
    - Runs the example flow once against live Postgres/Redis/http stub
    - Produces an NDJSON file containing:
      - outbound postgres record(s)
      - outbound redis record(s)
      - outbound http record(s)
      - (optional) inbound http record if you wrap the app as an HTTP server
  - Test: after capture run, cassette file exists and has ≥ 3 lines (example: no TDD; manual run with services up)

## 20.3 Replay demo (no live deps)
- [ ] Task 20.3.1 Add replay runner script: `npm run example:replay`
  - Env:
    - `SOFTPROBE_MODE=REPLAY`
    - `SOFTPROBE_STRICT_REPLAY=1`
    - Points to the recorded cassette file
  - Behavior:
    - Runs the same example flow
    - Postgres and Redis should be allowed to be OFFLINE (stop containers)
    - HTTP stub server should be OFFLINE (do not start)
    - Output JSON should match the capture run (or match a golden snapshot)
  - Test: with services stopped, replay run still succeeds and output matches snapshot

- [ ] Task 20.3.2 Add strict-mode negative test (proves isolation)
  - Modify the example flow to perform an extra, unrecorded call (e.g., different SQL or new URL)
  - Test: replay fails with strict error and does NOT attempt live network (assert passthrough not called)

## 20.4 Custom matcher example (customer control)
- [ ] Task 20.4.1 Add `examples/basic-app/custom-matcher.ts` demonstrating matcher injection
  - Example behaviors (pick 1–2):
    - Override Redis GET for a specific key to return `null` (force cache miss)
    - Normalize dynamic HTTP query params (e.g., `?ts=`) by matching only path
    - Force a specific SQL to map to a specific recorded response regardless of call sequence
  - Test: unit test custom matcher is invoked before default matcher and wins

- [ ] Task 20.4.2 Add “how to use custom matcher” snippet to README
  - Include a complete code sample using:
    - `softprobe.run({ mode: 'REPLAY', storage, traceId }, async () => { ... })`
    - `softprobe.getActiveMatcher().use((span, records) => { ... })`
  - Test: docs lint (if any) or simple presence check

## 20.5 Documentation polish (customer-facing)
- [ ] Task 20.5.1 Add `examples/basic-app/README.md`
  - Must include:
    - prerequisites (node, docker)
    - start services
    - capture command
    - stop services
    - replay command
    - how strict mode behaves
    - custom matcher explanation

- [ ] Task 20.5.2 Add top-level docs section “Quickstart: Record & Replay”
  - Link to the example
  - Show expected output snippets (short)
  - Test: docs build/lint if applicable
  - Test: smoke check: all commands referenced exist in package.json scripts
