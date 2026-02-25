# Softprobe Implementation Tracker — V6 Atomic TDD Plan

This tracker is rebuilt for the new design docs:
- `design.md`
- `design-context.md`
- `design-cassette.md`
- `design-matcher.md`

Implementation rule per task:
1. write test
2. run and verify fail (red)
3. minimal implementation
4. run and verify pass (green)
5. mark `[x]` with short commit note

> Do not implement ahead of the first unchecked task.

---

## Legend
- `[ ]` not started
- `[x]` completed (append short commit-style note)

---

## 1) Core Contracts (Types) — Atomic

- [x] **Task 1.1 Add `SoftprobeMode` type** — `feat(types): add SoftprobeMode union and compile-time type test`
  - **Test**: compile-time assertions allow only `CAPTURE | REPLAY | PASSTHROUGH`.

- [ ] **Task 1.2 Add `Cassette` interface**
  - **Test**: compile-time assertions for:
    - `loadTrace(traceId): Promise<SoftprobeCassetteRecord[]>`
    - `saveRecord(traceId, record): Promise<void>`
    - optional `flush(): Promise<void>`

- [ ] **Task 1.3 Add `SoftprobeRunOptions` type**
  - **Test**: compile-time checks require `mode`, `storage`, `traceId`; optional `matcher`.

- [ ] **Task 1.4 Align `SoftprobeCassetteRecord` schema to NDJSON design contract**
  - **Test**: type test for required identity fields (`version`, `traceId`, `spanId`, `timestamp`, `type`, `protocol`, `identifier`).

---

## 2) Context Refactor (`design-context.md`) — Atomic

- [ ] **Task 2.1 Migrate stored context shape from `cassettePath` to `storage: Cassette`**
  - **Test**: `SoftprobeContext.active()` exposes `storage` when set in context.

- [ ] **Task 2.2 Add `getCassette(otelContext?)` getter**
  - **Test**: returns the same cassette instance passed via `withData`/`run`.

- [ ] **Task 2.3 Make `getTraceId()` strict during scoped runs**
  - **Test**: inside `SoftprobeContext.run(...)`, `getTraceId()` is always non-empty.

- [ ] **Task 2.4 Refactor `run` signature to `run(options, fn)`**
  - **Test**: callback sees active context values: `mode`, `traceId`, `storage`.

- [ ] **Task 2.5 Implement REPLAY initialization in `run` using cassette load**
  - **Test**: in REPLAY, `storage.loadTrace(traceId)` called once per run.

- [ ] **Task 2.6 Seed matcher records in REPLAY branch**
  - **Test**: active matcher receives loaded records before callback logic executes.

- [ ] **Task 2.7 Keep CAPTURE branch read-free**
  - **Test**: in CAPTURE, `storage.loadTrace` is never called.

---

## 3) Cassette Runtime (`design-cassette.md`) — Atomic

- [ ] **Task 3.1 Implement `NdjsonCassette.loadTrace` adapter**
  - **Test**: fixture NDJSON returns only matching trace records.

- [ ] **Task 3.2 Implement `NdjsonCassette.saveRecord` adapter**
  - **Test**: one record append results in one NDJSON line.

- [ ] **Task 3.3 Implement optional `NdjsonCassette.flush` passthrough**
  - **Test**: delegates to underlying queue/store flush when available.

- [ ] **Task 3.4 Add context-aware capture write helper**
  - **Test**: in CAPTURE mode, helper calls `getCassette().saveRecord(getTraceId(), record)`.

- [ ] **Task 3.5 Add context-aware flush helper**
  - **Test**: helper calls `cassette.flush?.()` and safely no-ops when undefined.

---

## 4) Matcher Runtime (`design-matcher.md`) — Atomic

- [ ] **Task 4.1 Verify `SoftprobeMatcher` chain contract**
  - **Test**: first non-`CONTINUE` action wins; all-continue returns `CONTINUE`.

- [ ] **Task 4.2 Implement/confirm default matcher key extraction from span bindings**
  - **Test**: postgres/redis/http spans map to deterministic `(protocol, identifier)` keys.

- [ ] **Task 4.3 Implement/confirm default matcher candidate filter + sequence policy**
  - **Test**: repeated identical outbound calls consume deterministic sequence order.

- [ ] **Task 4.4 Implement optional topology matcher**
  - **Test**: when parent span name disambiguates candidates, topology choice is preferred over flat pool.

- [ ] **Task 4.5 Keep strict-mode policy out of matcher layer**
  - **Test**: no-match from matcher returns `CONTINUE`; wrapper decides strict/dev behavior.

---

## 5) Middleware Entry Points — Atomic

- [ ] **Task 5.1 Express middleware uses `SoftprobeContext.run(options, next)`**
  - **Test**: downstream handler observes active `mode`, `traceId`, `storage`.

- [ ] **Task 5.2 Fastify plugin uses `SoftprobeContext.run(options, handler)`**
  - **Test**: route handler observes active `mode`, `traceId`, `storage`.

- [ ] **Task 5.3 Header coordination overrides defaults via run options**
  - **Test**: request `x-softprobe-*` values are reflected in active context.

---

## 6) Wrapper/Interceptor Alignment — Atomic

- [ ] **Task 6.1 Postgres replay wrapper reads matcher from active context only**
  - **Test**: replay mock works without global matcher fallback mutation.

- [ ] **Task 6.2 Redis replay wrapper reads matcher from active context only**
  - **Test**: replay mock works with context-seeded matcher records.

- [ ] **Task 6.3 HTTP replay interceptor reads matcher from active context only**
  - **Test**: replay handler returns mocked response using context matcher state.

- [ ] **Task 6.4 Wrapper strict/dev behavior remains wrapper-owned**
  - **Test**: strict mode hard-fails on `CONTINUE`; dev mode passthroughs.

- [ ] **Task 6.5 Capture hooks write through context cassette helper**
  - **Test**: inbound/outbound capture paths call cassette save with active trace id.

---

## 7) API Surface Migration — Atomic

- [ ] **Task 7.1 Remove/replace legacy `ReplayContext` and `cassettePath`-based run API**
  - **Test**: public API compiles with `SoftprobeRunOptions` (`storage`, not `cassettePath`).

- [ ] **Task 7.2 Remove legacy context shape assumptions in getters**
  - **Test**: API getters delegate to `SoftprobeContext` new fields only.

- [ ] **Task 7.3 Remove global replay matcher fallback path**
  - **Test**: replay behavior remains green with matcher sourced from active context.

---

## 8) Init/Boot Wiring — Atomic

- [ ] **Task 8.1 Construct `NdjsonCassette` in boot path**
  - **Test**: init creates cassette from configured NDJSON path.

- [ ] **Task 8.2 Pass cassette instance into middleware/context run entry points**
  - **Test**: request path receives same cassette object from boot wiring.

- [ ] **Task 8.3 Keep import-order safety before OTel wrapper activation**
  - **Test**: guard still throws when dependency module was wrapped before softprobe init.

---

## 9) Regression + E2E Coverage — Atomic

- [ ] **Task 9.1 Capture E2E writes inbound+outbound NDJSON via cassette interface**
  - **Test**: recorded file contains expected trace-scoped records.

- [ ] **Task 9.2 Replay E2E runs with dependencies offline**
  - **Test**: strict replay succeeds for recorded paths without live DB/Redis/HTTP.

- [ ] **Task 9.3 Strict negative E2E for unrecorded call**
  - **Test**: unrecorded outbound call fails deterministically and does not hit network.

---

## 10) Docs + Consistency Cleanup — Atomic

- [ ] **Task 10.1 Update README snippets to `run({ mode, storage, traceId }, fn)`**
  - **Test**: grep/snapshot check contains no stale `cassettePath` API examples for new flow.

- [ ] **Task 10.2 Remove stale legacy wording across docs/comments**
  - **Test**: grep check for removed legacy terms (e.g., deprecated context API names) in active docs.

- [ ] **Task 10.3 Keep design links consistent with `design-*.md` convention**
  - **Test**: link check for `design.md`, `design-context.md`, `design-cassette.md`, `design-matcher.md`.

---

## Done Criteria (V6)

- `SoftprobeContext.run(options, fn)` is the single scoped execution API.
- Context stores `storage: Cassette` (no `cassettePath` in runtime context contract).
- Replay loads records via cassette and seeds matcher in active context.
- Capture writes records through cassette interface from active context.
- Matchers remain pure selection logic; strict/dev behavior remains in wrappers.
- Docs and examples use `design-*.md` naming and new API shape.
