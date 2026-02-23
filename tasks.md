# Softprobe Implementation Tracker — V4.1 Atomic TDD Plan

This file restructures the V4.1 work into **small, sequential, test-first** tasks (atomic units).  
Keep each task to: **(A) write test → (B) see it fail → (C) minimal code → (D) green → (E) mark [x] with short commit note**.

> Notes:
> - **Do not implement ahead** of the first unchecked task.
> - **Wrappers enforce strict/dev policy**; **matchers never passthrough**.
> - **NDJSON side-channel** is the capture source of truth (no payloads in span attrs).

---

## Legend
- `[ ]` not started
- `[x]` completed (add a short commit-style note)

---

# 0) Historical (already done — keep as-is)

## Phase 1: Foundation & Types (V2 Completed)
- [x] Task 1.1 Project Initialization *(chore: init package, tsconfig, jest, dummy test)*
- [x] Task 1.2 Schema Definitions *(feat: add schema types, schema.test.ts)*

## Phase 2: Core Engine (V2 Completed)
- [x] Task 2.1 SemanticMatcher Shell *(feat: shell, findMatch throws)*
- [x] Task 2.2 Flat Matching Logic *(feat: protocol+identifier match)*
- [x] Task 2.3 Lineage/Tree Matching *(feat: parent-span heuristic)*
- [x] Task 2.4 Dedup + Sequential *(feat: call sequence map)*
- [x] Task 2.5 User Overrides *(feat: custom matcher injection)*

## Phase 3: Global State (V2 Completed)
- [x] Task 3.1 AsyncLocalStorage Trace Isolation *(feat: ALS context)*

## Transitional (V3 partially started; v4.1 supersedes)
- [x] Task 4.1 (V3) Schema Update *(feat: initial cassette alignment; now superseded by v4.1 schema below)*

---

# 1) V4.1 Schema (NDJSON record) — Atomic

## 1.1 Types: enums + record type
- [x] Task 1.1.1 Add `Protocol` union type *(feat: Protocol includes grpc; schema.types.test.ts)*
  - Test: `schema.types.test.ts` compiles with `Protocol = "http" | "postgres" | "redis" | "amqp" | "grpc"`
- [x] Task 1.1.2 Add `RecordType` union type *(feat: RecordType inbound|outbound|metadata; schema.types.test)*
  - Test: compilation, `RecordType = "inbound" | "outbound" | "metadata"`
- [x] Task 1.1.3 Add `SoftprobeCassetteRecord` type with `version: "4.1"` *(feat: v4.1 record shape; version, type, timestamp, spanName; schema.test updated)*
  - Test: type-level test asserts literal `"4.1"` and required keys exist
- [x] Task 1.1.4 Add minimal runtime guard `isCassetteRecord(obj): boolean` (optional but useful) *(feat: isCassetteRecord in schema.ts; type predicate)*
  - Test: valid record returns true; missing version returns false

## 1.2 Identifier builders (pure)
- [x] Task 1.2.1 Implement `httpIdentifier(method, url)` *(feat: identifier.ts; METHOD url)*
  - Test: `POST`, `https://a/b` => `POST https://a/b`
- [x] Task 1.2.2 Implement `redisIdentifier(cmd, args)` *(feat: CMD args joined; identifier.test)*
  - Test: `get`, `["k"]` => `GET k`
- [x] Task 1.2.3 Implement `pgIdentifier(sql)` (pass-through for now) *(feat: pgIdentifier pass-through)*
  - Test: keeps input string exactly (normalization deferred)

---

# 2) Matcher Model (v4 list-of-fns) — Atomic

## 2.1 MatcherAction + MatcherFn
- [x] Task 2.1.1 Define `MatcherAction` discriminated union *(feat: MatcherAction in schema.ts; matcher.types.test.ts)*
  - Test: compilation; `action` narrows payload fields
- [x] Task 2.1.2 Define `MatcherFn(span, records)` *(feat: MatcherFn in schema.ts; matcher.types.test)*
  - Test: compilation; signature matches intended use

## 2.2 SoftprobeMatcher class behavior
- [x] Task 2.2.1 `use(fn)` appends matcher fns *(feat: SoftprobeMatcher in replay/softprobe-matcher.ts; match order test)*
  - Test: after 2 uses, internal list length is 2 (use a public-only behavior check, e.g., match order)
- [x] Task 2.2.2 `clear()` removes all matchers *(feat: clear() in SoftprobeMatcher)*
  - Test: after clear, match returns CONTINUE
- [x] Task 2.2.3 `_setRecords(records)` stores record list *(test: fn receives list in softprobe-matcher.test)*
  - Test: when fn inspects records, it receives the new list
- [x] Task 2.2.4 `match()` returns first non-CONTINUE *(test: fn1 CONTINUE fn2 MOCK => MOCK)*
  - Test: fn1 CONTINUE, fn2 MOCK => MOCK
- [x] Task 2.2.5 `match()` returns CONTINUE when all CONTINUE *(test: all CONTINUE => CONTINUE)*
  - Test: all CONTINUE => CONTINUE

---

# 3) Typed Bindings (span tagging) — Atomic

> All binding tests should use a **mock span** with a `setAttribute(k,v)` method and an `attributes` bag.

## 3.1 Shared helpers
- [x] Task 3.1.1 Create `testSpan()` helper for binding tests *(feat: bindings/test-span.ts + test-span.test.ts)*
  - Test: calling `setAttribute` populates `attributes`

## 3.2 PostgresSpan
- [x] Task 3.2.1 Implement `PostgresSpan.tagQuery(sql, values?)` *(feat: bindings/postgres-span.ts; uses pgIdentifier)*
  - Test: sets protocol attr and identifier attr
- [x] Task 3.2.2 Implement `PostgresSpan.fromSpan(span)` *(feat: fromSpan + PostgresSpanData; sql=identifier, values=[])*
  - Test: returns `{protocol:"postgres", identifier, sql, values}` (whatever fields you choose) or null when protocol mismatched

## 3.3 RedisSpan
- [x] Task 3.3.1 Implement `RedisSpan.tagCommand(cmd, args)` *(feat: bindings/redis-span.ts; redisIdentifier + args_json)*
  - Test: identifier uses `redisIdentifier` and args_json is JSON
- [x] Task 3.3.2 Implement `RedisSpan.fromSpan(span)` *(feat: fromSpan + RedisSpanData; parses args_json)*
  - Test: parses args_json; returns null when missing cmd/identifier

## 3.4 HttpSpan
- [x] Task 3.4.1 Implement `HttpSpan.tagRequest(method, url, bodyText?)` *(feat: bindings/http-span.ts; httpIdentifier + optional body)*
  - Test: identifier uses `httpIdentifier`; body stored optionally (small)
- [x] Task 3.4.2 Implement `HttpSpan.fromSpan(span)` *(feat: fromSpan + HttpSpanData)*
  - Test: returns protocol+identifier or null

---

# 4) Default Matcher (flat + sequence) — Atomic

## 4.1 Key extraction helper
- [x] Task 4.1.1 Implement `extractKeyFromSpan(span)` using typed bindings *(feat: replay/extract-key.ts; pg/redis/http fromSpan)*
  - Test: pg/redis/http span yields `{protocol, identifier}`; unknown yields null

## 4.2 Candidate selection
- [x] Task 4.2.1 Implement `filterOutboundCandidates(records, key)` *(feat: replay/extract-key.ts; type=outbound + protocol+identifier)*
  - Test: only outbound records with protocol+identifier returned

## 4.3 Call sequencing
- [x] Task 4.3.1 Implement `CallSeq` map (per protocol+identifier) *(feat: CallSeq.getAndIncrement in replay/extract-key.ts)*
  - Test: two calls pick candidates[0], then candidates[1]
- [x] Task 4.3.2 Wrap-around behavior (optional) *(feat: getAndIncrement(key, candidateCount) uses index % count)*
  - Test: if only 1 candidate, always returns it; if 2 and called 3 times returns 0,1,0 (or define your rule)

## 4.4 createDefaultMatcher()
- [x] Task 4.4.1 `createDefaultMatcher()` returns MatcherFn *(feat: createDefaultMatcher in replay/extract-key.ts)*
  - Test: returns MOCK with `responsePayload` from picked record
- [x] Task 4.4.2 When no candidates, returns CONTINUE *(test: empty candidates => CONTINUE)*
  - Test: empty candidates => CONTINUE

---

# 5) Topology Matcher (optional matcher fn) — Atomic

## 5.1 Parent name plumbing (test-only)
- [x] Task 5.1.1 Define how to read live parent name (stub for now) *(feat: getLiveParentName in replay/topology.ts; topology.test.ts)*
  - Test: if span has `_parentSpanName`, return it; else `"root"`

## 5.2 Lineage index
- [x] Task 5.2.1 Build `bySpanId` index from records *(feat: buildBySpanIdIndex in replay/topology.ts)*
  - Test: recorded parent lookup works

## 5.3 Candidate ranking
- [x] Task 5.3.1 Filter candidates by protocol+identifier *(feat: filterCandidatesByKey in topology; same as flat)*
  - Test: same as flat filter
- [x] Task 5.3.2 Prefer candidates whose recorded parent spanName matches live parent *(feat: selectLineagePool in topology.ts)*
  - Test: returns lineageMatches pool when available, else candidates

## 5.4 createTopologyMatcher()
- [x] Task 5.4.1 Returns MOCK payload from selected candidate (with sequencing key including parent name) *(feat: createTopologyMatcher in topology.ts)*
  - Test: two identical identifiers under different parents return correct payloads

---

# 6) Config Loader (.softprobe/config.yml) — Atomic

## 6.1 Parse + cache
- [x] Task 6.1.1 Implement `ConfigManager` that reads YAML synchronously at boot *(feat: config/config-manager.ts + fixture; .get() returns parsed YAML)*
  - Test: reads fixture config file and exposes `.get()`

## 6.2 ignoreUrls regex compilation
- [x] Task 6.2.1 Compile ignore patterns into RegExp[] *(feat: getIgnoreRegexes() from replay.ignoreUrls)*
  - Test: pattern `api\\.stripe\\.com` matches `https://api.stripe.com/v1/...`
- [x] Task 6.2.2 `shouldIgnore(url)` returns boolean *(feat: shouldIgnore uses ignoreRegexes; falsy url => false)*
  - Test: returns true for ignored, false for others

---

# 7) NDJSON Store (side-channel) — Atomic

## 7.1 Append queue (single-threaded)
- [x] Task 7.1.1 Implement `CassetteStore.enqueue(line)` FIFO *(feat: store/cassette-store.ts; enqueue + flush FIFO)*
  - Test: enqueue 3 lines, flush writes 3 in order
- [x] Task 7.1.2 Implement `saveRecord(record)` serializes JSON + newline *(feat: saveRecord in CassetteStore; one JSON per line)*
  - Test: file has exactly 1 JSON per line

## 7.2 Safety valves
- [x] Task 7.2.1 `maxQueueSize` drops and counts drops *(feat: CassetteStoreOptions.maxQueueSize, getDropCount())*
  - Test: set max=2, enqueue 5, assert dropCount=3
- [x] Task 7.2.2 Best-effort flush on exit signals (SIGINT/SIGTERM) *(feat: flushOnExit, register SIGINT/SIGTERM)*
  - Test: unit test by calling internal handler directly (don’t actually kill Jest)

## 7.3 Loader
- [x] Task 7.3.1 Implement `loadNdjson(path, traceId?)` streaming *(feat: store/load-ndjson.ts; readline streaming)*
  - Test: loads all when traceId undefined
- [x] Task 7.3.2 Filter by traceId *(test: loadNdjson(path, traceId) returns only matching records)*
  - Test: only matching traceId lines returned

---

# 8) Replay Context (ALS + record loading) — Atomic

## 8.1 ALS state shape
- [x] Task 8.1.1 Define ALS store `{ traceId?, cassettePath }` *(feat: ReplayContext has traceId? + cassettePath?; api.test runWithContext visibility)*
  - Test: `runWithContext` sets ALS store visible inside callback

## 8.2 runWithContext behavior
- [x] Task 8.2.1 `runWithContext` loads records once and sets into matcher *(feat: when cassettePath set, loadNdjson + SoftprobeMatcher._setRecords; api.test)*
  - Test: matcher fn sees records length > 0
- [x] Task 8.2.2 `runWithContext` sets inbound record cache *(feat: inboundRecord on context, getRecordedInboundResponse() in api.ts)*
  - Test: `getRecordedInboundResponse()` returns correct record

---

# 9) Replay Wrappers (strict policy lives here) — Atomic

> Each wrapper suite should validate 3 paths: MOCK / PASSTHROUGH / CONTINUE (strict vs dev).

## 9.1 Import-order guard (pg)
- [x] Task 9.1.1 Detect OTel-wrapped pg query and throw fatal *(feat: __wrapped check in setupPostgresReplay; import-order-guard.test.ts)*
  - Test: mark query fn with `__wrapped = true`, assert throw message includes “import softprobe/init BEFORE OTel”

## 9.2 Postgres replay wrapper
- [x] Task 9.2.1 Wrapper tags span via PostgresSpan.tagQuery *(feat: PostgresSpan.tagQuery in postgres wrapper; replay-postgres.test)*
  - Test: tagQuery called with SQL
- [x] Task 9.2.2 MOCK path returns pg-like result (promise) *(feat: test asserts result shape; existing impl)*
  - Test: returns `{rows,rowCount,command}`
- [x] Task 9.2.3 MOCK path supports callback style *(feat: test asserts callback async; existing impl)*
  - Test: callback receives mocked result async (nextTick)
- [x] Task 9.2.4 CONTINUE + STRICT throws *(feat: SOFTPROBE_STRICT_REPLAY=1 => throw "no match for pg.query")*
  - Test: env strict => throws
- [x] Task 9.2.5 CONTINUE + DEV passthrough calls original *(feat: no strict => original invoked; replay-postgres-passthrough.test.ts)*
  - Test: original invoked

## 9.3 Redis replay wrapper
- [x] Task 9.3.1 Wrapper tags span via RedisSpan.tagCommand *(feat: RedisSpan.tagCommand in redis replay; replay-redis.test 9.3.1)*
  - Test: called with cmd/args
- [x] Task 9.3.2 MOCK returns resolved promise payload *(feat: test 9.3.2 asserts resolved value; impl already returns Promise.resolve)*
  - Test: resolves value
- [x] Task 9.3.3 CONTINUE + STRICT throws *(feat: strict env => throw "no match for redis command"; replay-redis 9.3.3)*
  - Test: strict env => throws
- [x] Task 9.3.4 CONTINUE + DEV passthrough *(feat: no strict => originalExecutor invoked; replay-redis 9.3.4; Task 5.3 test set strict)*
  - Test: original invoked

## 9.4 HTTP replay interceptor (MSW)
- [x] Task 9.4.1 Interceptor ignores configured URLs *(feat: `handleHttpReplayRequest` bypasses matcher when `shouldIgnoreUrl(url)` returns true)*
  - Test: request to ignored URL does not call matcher
- [x] Task 9.4.2 MOCK responds with recorded payload *(feat: returns `Response` from matcher payload status/statusCode/body/headers)*
  - Test: returns Response with status/body
- [x] Task 9.4.3 CONTINUE + STRICT returns JSON error Response(500) *(feat: strict mode responds JSON + `x-softprobe-error: true`)*
  - Test: header `x-softprobe-error: true`
- [x] Task 9.4.4 CONTINUE + DEV allows passthrough *(feat: CONTINUE with strict unset does not call `respondWith`)*
  - Test: does not respond; request proceeds (mock the controller)

---

# 10) Capture Hooks (side-channel only) — Atomic

> Keep capture minimal and safe. Never throw in production hooks.

## 10.1 HTTP capture stream tap (utilities)
- [x] Task 10.1.1 Implement `tapReadableStream` with maxPayloadSize cap *(feat: capture/stream-tap.ts; cap + truncated)*
  - Test: cap truncates and sets `truncated=true` (or defined field)
- [x] Task 10.1.2 Tap does not consume original stream *(feat: PassThrough tee; consumer reads full)*
  - Test: original consumer still reads full stream (for small bodies)

## 10.2 HTTP inbound capture record writing
- [x] Task 10.2.1 Write inbound request record *(feat: capture/http-inbound.ts writeInboundHttpRecord)*
  - Test: store.saveRecord called with type=inbound protocol=http
- [x] Task 10.2.2 Write inbound response record (or embed in same record—choose one and test it) *(feat: same record requestPayload + responsePayload)*
  - Test: responsePayload includes status/body

## 10.3 Outbound HTTP capture
- [x] Task 10.3.1 Capture outbound request/response into record type=outbound *(feat: buildUndiciResponseHook writes to getCaptureStore; identifier METHOD url)*
  - Test: identifier matches `METHOD url`

## 10.4 Postgres capture (minimal)
- [x] Task 10.4.1 Capture query result rows into outbound record *(feat: responseHook writes outbound record via getCaptureStore; store-accessor.ts)*
  - Test: record.responsePayload.rows matches stub

## 10.5 Redis capture (minimal)
- [x] Task 10.5.1 Capture command result into outbound record *(feat: buildRedisResponseHook writes to getCaptureStore; responsePayload = response)*
  - Test: record.responsePayload equals stub

---

# 11) init.ts Boot Sequence — Atomic

## 11.1 Mode router
- [x] Task 11.1.1 `softprobe/init` reads `SOFTPROBE_MODE` *(feat: src/init.ts + exports ./init; REPLAY/CAPTURE modes)*
  - Test: requires module under REPLAY/CAPTURE modes
- [x] Task 11.1.2 REPLAY mode loads cassette synchronously (or eagerly) *(feat: init calls loadNdjson(SOFTPROBE_CASSETTE_PATH) once)*
  - Test: load called exactly once
- [x] Task 11.1.3 Applies adapter patches synchronously *(feat: init calls setupPostgresReplay, setupRedisReplay, setupUndiciReplay, setupHttpReplayInterceptor in REPLAY)*
  - Test: patch fns called during module import

---

# 12) E2E Child Process (Jest-safe) — Atomic

> Because Jest breaks some require-in-the-middle instrumentations.

## 12.1 Harness
- [x] Task 12.1.1 Add `test/e2e/run-child.ts` helper to spawn node scripts with env *(feat: run-child.ts in src/__tests__/e2e; run-child.test.ts)*
  - Test: child returns stdout and exit code

## 12.2 Postgres E2E
- [x] Task 12.2.1 CAPTURE script writes NDJSON with rows *(feat: init CAPTURE sets CassetteStore + flush; pg-cassette-capture-worker; postgres-cassette-capture.e2e.test)*
- [x] Task 12.2.2 REPLAY script works with DB disconnected *(feat: runWithContext registers default matcher; postgres wrapper uses SoftprobeMatcher.match(spanLike); E2E in-process replay)*

## 12.3 Redis E2E
- [x] Task 12.3.1 CAPTURE writes NDJSON *(feat: redis-cassette.e2e + redis-cassette-capture-worker; asserts outbound redis NDJSON records)*
- [x] Task 12.3.2 REPLAY works without redis *(feat: redis-replay-worker + strict replay assertion; returns recorded GET without live redis)*

## 12.4 HTTP E2E
- [x] Task 12.4.1 CAPTURE writes NDJSON *(feat: add child-process HTTP cassette capture E2E with outbound http NDJSON assertions)*
- [x] Task 12.4.2 REPLAY runs with network disabled (or no outbound calls) *(feat: add child-process HTTP replay worker asserting mocked fetch succeeds without live server)*

---

# 13) Strict Mode AC (network isolation) — Atomic

- [x] Task 13.1 In strict replay, unrecorded call hard-fails and does not touch real network *(feat: strict-mode.e2e.test + http-strict-replay-worker; assert 500 and no passthrough)*
  - Test: attempt unrecorded identifier; assert thrown / 500 response and verify passthrough not called

---

# 14) Server-Side Integration (Inbound & Frameworks) — Atomic

## 14.1 Express Middleware (Environment Aware)

* [x] Task 14.1.1 Implement `softprobeExpressMiddleware` capture path *(feat: capture/express.ts; taps res.send)*
* Test: when `SOFTPROBE_MODE=CAPTURE`, `res.send` triggers `CaptureEngine.queueInboundResponse` with status/body *(feat: CaptureEngine + express middleware; capture-express.test.ts)*


* [x] Task 14.1.2 Implement `softprobeExpressMiddleware` replay trigger *(feat: replay/express.ts; detect traceId and mode)*
* Test: when `SOFTPROBE_MODE=REPLAY` and traceId is in context, `activateReplayForContext(traceId)` is called *(feat: replay/express.ts + api getRecordsForTrace/activateReplayForContext/globalReplayMatcher; capture-express.test.ts)*


* [x] Task 14.1.3 Middleware correctly extracts Trace ID via native OTel context *(feat: trace.getActiveSpan().spanContext().traceId)*
* Test: middleware correctly identifies the traceId without manual header parsing *(test: req has wrong x-trace-id/traceparent; assert OTel traceId used; capture-express.test.ts)*



## 14.2 Fastify Plugin

* [x] Task 14.2.1 Implement `softprobeFastifyPlugin` using `onSend` hook *(feat: capture/fastify.ts; onSend for payload)*
* Test: `onSend` captures full payload and writes `inbound` record to side-channel *(feat: capture/fastify.ts + capture-fastify.test.ts; use fastify-plugin so hook runs for app routes)*


* [x] Task 14.2.2 Implement `preHandler` hook for replay initialization *(feat: replay/fastify.ts; preHandler primes matcher by traceId)*
* Test: hook primes the `SoftprobeMatcher` with records matching the active OTel traceId


- [x] Task 14.2.3 Apply framework mutators (feat: init calls applyFrameworkMutators() to hook Express/Fastify)
  - Test: require('express'); assert app.use was called internally by Softprobe without user intervention. *(feat: capture/framework-mutator.ts + init CAPTURE/REPLAY)*

## 14.3 Body Parsing Coordination

* [x] Task 14.3.1 Ensure `HttpSpan.tagInboundRequest` captures `req.body` correctly *(feat: capture/http-inbound.ts)*
* Test: request record in NDJSON contains parsed JSON body when middleware is placed after `body-parser` *(feat: Express middleware passes req.body to queueInboundResponse → writeInboundHttpRecord)*

## 14.4 Server-Side E2E Coverage (Child Process)

* [x] Task 14.4.1 Express capture E2E writes inbound + outbound records *(feat: src/__tests__/e2e/express-inbound-capture.e2e.test.ts + helper worker)*
* Test: run express app in `CAPTURE`; hit one route; NDJSON contains inbound record (status/body) and at least one outbound record (http/redis/postgres) *(express-inbound-capture.e2e.test + runServer/waitForServer + /exit flush)*


* [ ] Task 14.4.2 Express replay E2E succeeds with dependencies offline *(feat: src/__tests__/e2e/express-inbound-replay.e2e.test.ts + helper worker)*
* Test: run express app in `REPLAY` + strict mode with Postgres/Redis/http dependency disabled; request succeeds from cassette only


* [ ] Task 14.4.3 Fastify capture/replay E2E parity *(feat: src/__tests__/e2e/fastify-inbound-cassette.e2e.test.ts + helper worker)*
* Test: same route flow in Fastify captures inbound payload and replays without live dependencies


* [ ] Task 14.4.4 Server-side strict negative E2E proves network isolation *(feat: src/__tests__/e2e/server-inbound-strict-negative.e2e.test.ts)*
* Test: replay request with an unrecorded outbound call fails deterministically and verifies passthrough/network call is not invoked

---
# 15) Automated Replay Coordination & Comparison — Atomic

## 15.1 OTel Baggage Propagation

* [ ] Task 15.1.1 Inject `softprobe-mode: REPLAY` into OTel Baggage *(feat: api/baggage.ts)*
* Test: setting global REPLAY mode adds entry to current OTel baggage


* [ ] Task 15.1.2 Downstream shims check baggage for mode *(feat: replay/http-shim.ts)*
* Test: outbound fetch shim automatically switches to MOCK when baggage contains `softprobe-mode: REPLAY`



## 15.2 Inbound Comparison Utility

* [ ] Task 15.2.1 Implement `softprobe.compareInbound(actualResponse)` helper *(feat: api/compare.ts)*
* Test: helper retrieves recorded `inbound` record and performs deep equality check on status/body


* [ ] Task 15.2.2 Add `SOFTPROBE_STRICT_COMPARISON` env check *(feat: compare.ts strict flag)*
* Test: when strict, mismatched headers cause failure; when off, only status/body matter



## 15.3 Automatic Record Loading in Middleware

* [ ] Task 15.3.1 Middleware loads specific trace records from eager-loaded global store *(feat: replay/store-accessor.ts)*
* Test: middleware retrieves only records for the current `traceId` from the store initialized at boot


---

# 16) User-Facing Example App + Record/Replay Demo — Atomic

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

## 16.1 Example app skeleton (no Softprobe yet)
- [x] Task 16.1.1 Scaffold `examples/basic-app` with a single entry script *(feat: examples/basic-app/run.ts + basic-app-example.e2e.test)*
  - **User-facing**: normal app with real Postgres + Redis + HTTP. Default env points at local Docker (docker-compose); no mocks in the app itself.
  - App behavior (single request/flow):
    1) Insert/select from Postgres (or select-only if easier)
    2) Read/write Redis cache
    3) Call an HTTP service (e.g. httpbin.org or local stub)
    4) Return a JSON response containing all three results
  - Test: `node examples/basic-app/run.js` (or ts) exits 0 and prints JSON (E2E can use Testcontainers; demo assumes Docker).

- [x] Task 16.1.2 HTTP for demo: deterministic outbound call *(feat: httpbin.org in run.ts; E2E asserts http.url contains httpbin.org)*
  - Use httpbin.org (or optional local stub) so the example has a deterministic HTTP dependency.
  - Test: app run includes `http` in output; optional `curl` test for stub if used.

- [x] Task 16.1.3 Provide docker-compose for Postgres + Redis (example-only) *(feat: docker-compose.e2e.test.ts; compose already present, test verifies up → run → JSON)*
  - Standard way to run the demo: `docker compose up -d` in examples/basic-app (or repo root); app connects via default PG_URL / REDIS_URL (e.g. localhost).
  - Test: `docker compose up -d` brings services up; `npm run example:run` (or equivalent) connects and prints JSON

## 16.2 Capture demo (record NDJSON)
- [ ] Task 16.2.1 Add capture runner script: `npm run example:capture`
  - Env:
    - `SOFTPROBE_MODE=CAPTURE`
    - `SOFTPROBE_CASSETTE=./examples/basic-app/softprobe-cassettes.ndjson` (or your chosen config path)
  - Behavior:
    - Runs the example flow once against live Postgres/Redis/http stub
    - Produces an NDJSON file containing:
      - outbound postgres record(s)
      - outbound redis record(s)
      - outbound http record(s)
      - (optional) inbound http record if you wrap the app as an HTTP server
  - Test: after capture run, cassette file exists and has ≥ 3 lines

- [ ] Task 16.2.2 Add a test to validate “no span bloat” in capture demo
  - Minimal approach:
    - assert the produced cassette includes payload bodies
    - assert captured spans (if exported/printed) do not contain large payload fields
  - Test: verify payload appears in NDJSON but not in span attributes output (if you emit spans)

## 16.3 Replay demo (no live deps)
- [ ] Task 16.3.1 Add replay runner script: `npm run example:replay`
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

- [ ] Task 16.3.2 Add strict-mode negative test (proves isolation)
  - Modify the example flow to perform an extra, unrecorded call (e.g., different SQL or new URL)
  - Test: replay fails with strict error and does NOT attempt live network (assert passthrough not called)

## 16.4 Custom matcher example (customer control)
- [ ] Task 16.4.1 Add `examples/basic-app/custom-matcher.ts` demonstrating matcher injection
  - Example behaviors (pick 1–2):
    - Override Redis GET for a specific key to return `null` (force cache miss)
    - Normalize dynamic HTTP query params (e.g., `?ts=`) by matching only path
    - Force a specific SQL to map to a specific recorded response regardless of call sequence
  - Test: unit test custom matcher is invoked before default matcher and wins

- [ ] Task 16.4.2 Add “how to use custom matcher” snippet to README
  - Include a complete code sample using:
    - `softprobe.runWithContext({ traceId, cassettePath }, async () => { ... })`
    - `softprobe.getActiveMatcher().use((span, records) => { ... })`
  - Test: docs lint (if any) or simple presence check

## 16.5 Documentation polish (customer-facing)
- [ ] Task 16.5.1 Add `examples/basic-app/README.md`
  - Must include:
    - prerequisites (node, docker)
    - start services
    - capture command
    - stop services
    - replay command
    - how strict mode behaves
    - custom matcher explanation
  - Test: smoke check: all commands referenced exist in package.json scripts

- [ ] Task 16.5.2 Add top-level docs section “Quickstart: Record & Replay”
  - Link to the example
  - Show expected output snippets (short)
  - Test: docs build/lint if applicable

---

## Done Criteria (V4.1)

* Matcher list model is the only matcher system in use.
* Typed bindings exist for pg/redis/http.
* Capture writes NDJSON via queue; payload never stored in span attributes.
* Wrappers own strict vs dev behavior.
* Optional topology matcher works as a matcher fn.
* E2E child-process tests validate capture + replay + strict isolation.
* Server-side frameworks (Express/Fastify) support high-fidelity inbound capture and automatic mock injection.
