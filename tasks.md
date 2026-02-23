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
- [ ] Task 1.1.1 Add `Protocol` union type
  - Test: `schema.types.test.ts` compiles with `Protocol = "http" | "postgres" | "redis" | "amqp" | "grpc"`
- [ ] Task 1.1.2 Add `RecordType` union type
  - Test: compilation, `RecordType = "inbound" | "outbound" | "metadata"`
- [ ] Task 1.1.3 Add `SoftprobeCassetteRecord` type with `version: "4.1"`
  - Test: type-level test asserts literal `"4.1"` and required keys exist
- [ ] Task 1.1.4 Add minimal runtime guard `isCassetteRecord(obj): boolean` (optional but useful)
  - Test: valid record returns true; missing version returns false

## 1.2 Identifier builders (pure)
- [ ] Task 1.2.1 Implement `httpIdentifier(method, url)`
  - Test: `POST`, `https://a/b` => `POST https://a/b`
- [ ] Task 1.2.2 Implement `redisIdentifier(cmd, args)`
  - Test: `get`, `["k"]` => `GET k`
- [ ] Task 1.2.3 Implement `pgIdentifier(sql)` (pass-through for now)
  - Test: keeps input string exactly (normalization deferred)

---

# 2) Matcher Model (v4 list-of-fns) — Atomic

## 2.1 MatcherAction + MatcherFn
- [ ] Task 2.1.1 Define `MatcherAction` discriminated union
  - Test: compilation; `action` narrows payload fields
- [ ] Task 2.1.2 Define `MatcherFn(span, records)`
  - Test: compilation; signature matches intended use

## 2.2 SoftprobeMatcher class behavior
- [ ] Task 2.2.1 `use(fn)` appends matcher fns
  - Test: after 2 uses, internal list length is 2 (use a public-only behavior check, e.g., match order)
- [ ] Task 2.2.2 `clear()` removes all matchers
  - Test: after clear, match returns CONTINUE
- [ ] Task 2.2.3 `_setRecords(records)` stores record list
  - Test: when fn inspects records, it receives the new list
- [ ] Task 2.2.4 `match()` returns first non-CONTINUE
  - Test: fn1 CONTINUE, fn2 MOCK => MOCK
- [ ] Task 2.2.5 `match()` returns CONTINUE when all CONTINUE
  - Test: all CONTINUE => CONTINUE

---

# 3) Typed Bindings (span tagging) — Atomic

> All binding tests should use a **mock span** with a `setAttribute(k,v)` method and an `attributes` bag.

## 3.1 Shared helpers
- [ ] Task 3.1.1 Create `testSpan()` helper for binding tests
  - Test: calling `setAttribute` populates `attributes`

## 3.2 PostgresSpan
- [ ] Task 3.2.1 Implement `PostgresSpan.tagQuery(sql, values?)`
  - Test: sets protocol attr and identifier attr
- [ ] Task 3.2.2 Implement `PostgresSpan.fromSpan(span)`
  - Test: returns `{protocol:"postgres", identifier, sql, values}` (whatever fields you choose) or null when protocol mismatched

## 3.3 RedisSpan
- [ ] Task 3.3.1 Implement `RedisSpan.tagCommand(cmd, args)`
  - Test: identifier uses `redisIdentifier` and args_json is JSON
- [ ] Task 3.3.2 Implement `RedisSpan.fromSpan(span)`
  - Test: parses args_json; returns null when missing cmd/identifier

## 3.4 HttpSpan
- [ ] Task 3.4.1 Implement `HttpSpan.tagRequest(method, url, bodyText?)`
  - Test: identifier uses `httpIdentifier`; body stored optionally (small)
- [ ] Task 3.4.2 Implement `HttpSpan.fromSpan(span)`
  - Test: returns protocol+identifier or null

---

# 4) Default Matcher (flat + sequence) — Atomic

## 4.1 Key extraction helper
- [ ] Task 4.1.1 Implement `extractKeyFromSpan(span)` using typed bindings
  - Test: pg/redis/http span yields `{protocol, identifier}`; unknown yields null

## 4.2 Candidate selection
- [ ] Task 4.2.1 Implement `filterOutboundCandidates(records, key)`
  - Test: only outbound records with protocol+identifier returned

## 4.3 Call sequencing
- [ ] Task 4.3.1 Implement `CallSeq` map (per protocol+identifier)
  - Test: two calls pick candidates[0], then candidates[1]
- [ ] Task 4.3.2 Wrap-around behavior (optional)
  - Test: if only 1 candidate, always returns it; if 2 and called 3 times returns 0,1,0 (or define your rule)

## 4.4 createDefaultMatcher()
- [ ] Task 4.4.1 `createDefaultMatcher()` returns MatcherFn
  - Test: returns MOCK with `responsePayload` from picked record
- [ ] Task 4.4.2 When no candidates, returns CONTINUE
  - Test: empty candidates => CONTINUE

---

# 5) Topology Matcher (optional matcher fn) — Atomic

## 5.1 Parent name plumbing (test-only)
- [ ] Task 5.1.1 Define how to read live parent name (stub for now)
  - Test: if span has `_parentSpanName`, return it; else `"root"`

## 5.2 Lineage index
- [ ] Task 5.2.1 Build `bySpanId` index from records
  - Test: recorded parent lookup works

## 5.3 Candidate ranking
- [ ] Task 5.3.1 Filter candidates by protocol+identifier
  - Test: same as flat filter
- [ ] Task 5.3.2 Prefer candidates whose recorded parent spanName matches live parent
  - Test: returns lineageMatches pool when available, else candidates

## 5.4 createTopologyMatcher()
- [ ] Task 5.4.1 Returns MOCK payload from selected candidate (with sequencing key including parent name)
  - Test: two identical identifiers under different parents return correct payloads

---

# 6) Config Loader (.softprobe/config.yml) — Atomic

## 6.1 Parse + cache
- [ ] Task 6.1.1 Implement `ConfigManager` that reads YAML synchronously at boot
  - Test: reads fixture config file and exposes `.get()`

## 6.2 ignoreUrls regex compilation
- [ ] Task 6.2.1 Compile ignore patterns into RegExp[]
  - Test: pattern `api\\.stripe\\.com` matches `https://api.stripe.com/v1/...`
- [ ] Task 6.2.2 `shouldIgnore(url)` returns boolean
  - Test: returns true for ignored, false for others

---

# 7) NDJSON Store (side-channel) — Atomic

## 7.1 Append queue (single-threaded)
- [ ] Task 7.1.1 Implement `CassetteStore.enqueue(line)` FIFO
  - Test: enqueue 3 lines, flush writes 3 in order
- [ ] Task 7.1.2 Implement `saveRecord(record)` serializes JSON + newline
  - Test: file has exactly 1 JSON per line

## 7.2 Safety valves
- [ ] Task 7.2.1 `maxQueueSize` drops and counts drops
  - Test: set max=2, enqueue 5, assert dropCount=3
- [ ] Task 7.2.2 Best-effort flush on exit signals (SIGINT/SIGTERM)
  - Test: unit test by calling internal handler directly (don’t actually kill Jest)

## 7.3 Loader
- [ ] Task 7.3.1 Implement `loadNdjson(path, traceId?)` streaming
  - Test: loads all when traceId undefined
- [ ] Task 7.3.2 Filter by traceId
  - Test: only matching traceId lines returned

---

# 8) Replay Context (ALS + record loading) — Atomic

## 8.1 ALS state shape
- [ ] Task 8.1.1 Define ALS store `{ traceId?, cassettePath }`
  - Test: `runWithContext` sets ALS store visible inside callback

## 8.2 runWithContext behavior
- [ ] Task 8.2.1 `runWithContext` loads records once and sets into matcher
  - Test: matcher fn sees records length > 0
- [ ] Task 8.2.2 `runWithContext` sets inbound record cache
  - Test: `getRecordedInboundResponse()` returns correct record

---

# 9) Replay Wrappers (strict policy lives here) — Atomic

> Each wrapper suite should validate 3 paths: MOCK / PASSTHROUGH / CONTINUE (strict vs dev).

## 9.1 Import-order guard (pg)
- [ ] Task 9.1.1 Detect OTel-wrapped pg query and throw fatal
  - Test: mark query fn with `__wrapped = true`, assert throw message includes “import softprobe/init BEFORE OTel”

## 9.2 Postgres replay wrapper
- [ ] Task 9.2.1 Wrapper tags span via PostgresSpan.tagQuery
  - Test: tagQuery called with SQL
- [ ] Task 9.2.2 MOCK path returns pg-like result (promise)
  - Test: returns `{rows,rowCount,command}`
- [ ] Task 9.2.3 MOCK path supports callback style
  - Test: callback receives mocked result async (nextTick)
- [ ] Task 9.2.4 CONTINUE + STRICT throws
  - Test: env strict => throws
- [ ] Task 9.2.5 CONTINUE + DEV passthrough calls original
  - Test: original invoked

## 9.3 Redis replay wrapper
- [ ] Task 9.3.1 Wrapper tags span via RedisSpan.tagCommand
  - Test: called with cmd/args
- [ ] Task 9.3.2 MOCK returns resolved promise payload
  - Test: resolves value
- [ ] Task 9.3.3 CONTINUE + STRICT throws
  - Test: strict env => throws
- [ ] Task 9.3.4 CONTINUE + DEV passthrough
  - Test: original invoked

## 9.4 HTTP replay interceptor (MSW)
- [ ] Task 9.4.1 Interceptor ignores configured URLs
  - Test: request to ignored URL does not call matcher
- [ ] Task 9.4.2 MOCK responds with recorded payload
  - Test: returns Response with status/body
- [ ] Task 9.4.3 CONTINUE + STRICT returns JSON error Response(500)
  - Test: header `x-softprobe-error: true`
- [ ] Task 9.4.4 CONTINUE + DEV allows passthrough
  - Test: does not respond; request proceeds (mock the controller)

---

# 10) Capture Hooks (side-channel only) — Atomic

> Keep capture minimal and safe. Never throw in production hooks.

## 10.1 HTTP capture stream tap (utilities)
- [ ] Task 10.1.1 Implement `tapReadableStream` with maxPayloadSize cap
  - Test: cap truncates and sets `truncated=true` (or defined field)
- [ ] Task 10.1.2 Tap does not consume original stream
  - Test: original consumer still reads full stream (for small bodies)

## 10.2 HTTP inbound capture record writing
- [ ] Task 10.2.1 Write inbound request record
  - Test: store.saveRecord called with type=inbound protocol=http
- [ ] Task 10.2.2 Write inbound response record (or embed in same record—choose one and test it)
  - Test: responsePayload includes status/body

## 10.3 Outbound HTTP capture
- [ ] Task 10.3.1 Capture outbound request/response into record type=outbound
  - Test: identifier matches `METHOD url`

## 10.4 Postgres capture (minimal)
- [ ] Task 10.4.1 Capture query result rows into outbound record
  - Test: record.responsePayload.rows matches stub

## 10.5 Redis capture (minimal)
- [ ] Task 10.5.1 Capture command result into outbound record
  - Test: record.responsePayload equals stub

---

# 11) init.ts Boot Sequence — Atomic

## 11.1 Mode router
- [ ] Task 11.1.1 `softprobe/init` reads `SOFTPROBE_MODE`
  - Test: requires module under REPLAY/CAPTURE modes
- [ ] Task 11.1.2 REPLAY mode loads cassette synchronously (or eagerly)
  - Test: load called exactly once
- [ ] Task 11.1.3 Applies adapter patches synchronously
  - Test: patch fns called during module import

---

# 12) E2E Child Process (Jest-safe) — Atomic

> Because Jest breaks some require-in-the-middle instrumentations.

## 12.1 Harness
- [ ] Task 12.1.1 Add `test/e2e/run-child.ts` helper to spawn node scripts with env
  - Test: child returns stdout and exit code

## 12.2 Postgres E2E
- [ ] Task 12.2.1 CAPTURE script writes NDJSON with rows
- [ ] Task 12.2.2 REPLAY script works with DB disconnected
- [ ] Task 12.2.3 Assert “zero span bloat” (no payload in span attrs)

## 12.3 Redis E2E
- [ ] Task 12.3.1 CAPTURE writes NDJSON
- [ ] Task 12.3.2 REPLAY works without redis

## 12.4 HTTP E2E
- [ ] Task 12.4.1 CAPTURE writes NDJSON
- [ ] Task 12.4.2 REPLAY runs with network disabled (or no outbound calls)

---

# 13) Strict Mode AC (network isolation) — Atomic

- [ ] Task 13.1 In strict replay, unrecorded call hard-fails and does not touch real network
  - Test: attempt unrecorded identifier; assert thrown / 500 response and verify passthrough not called

---

## Done Criteria (V4.1)
- Matcher list model is the only matcher system in use.
- Typed bindings exist for pg/redis/http.
- Capture writes NDJSON via queue; payload never stored in span attributes.
- Wrappers own strict vs dev behavior.
- Optional topology matcher works as a matcher fn.
- E2E child-process tests validate capture + replay + strict isolation.