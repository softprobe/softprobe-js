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

- [x] **Task 1.2 Add `Cassette` interface** — `feat(types): add Cassette contract for trace storage`
  - **Test**: compile-time assertions for:
    - `loadTrace(traceId): Promise<SoftprobeCassetteRecord[]>`
    - `saveRecord(traceId, record): Promise<void>`
    - optional `flush(): Promise<void>`

- [x] **Task 1.3 Add `SoftprobeRunOptions` type** — `feat(types): add SoftprobeRunOptions contract and test`
  - **Test**: compile-time checks require `mode`, `storage`, `traceId`; optional `matcher`.

- [x] **Task 1.4 Align `SoftprobeCassetteRecord` schema to NDJSON design contract** — `feat(types): confirm cassette record identity keys are required`
  - **Test**: type test for required identity fields (`version`, `traceId`, `spanId`, `timestamp`, `type`, `protocol`, `identifier`).

---

## 2) Context Refactor (`design-context.md`) — Atomic

- [x] **Task 2.1 Migrate stored context shape from `cassettePath` to `storage: Cassette`** — `feat(context): store Cassette instance instead of cassettePath`
  - **Test**: `SoftprobeContext.active()` exposes `storage` when set in context.

- [x] **Task 2.2 Add `getCassette(otelContext?)` getter** — `feat(context): expose active cassette getter for withData/run scopes`
  - **Test**: returns the same cassette instance passed via `withData`/`run`.

- [x] **Task 2.3 Make `getTraceId()` strict during scoped runs** — `feat(context): make getTraceId return string and enforce non-empty in run scope`
  - **Test**: inside `SoftprobeContext.run(...)`, `getTraceId()` is always non-empty.

- [x] **Task 2.4 Refactor `run` signature to `run(options, fn)`** — `refactor(context): require SoftprobeRunOptions in run and assert options-based context scope`
  - **Test**: callback sees active context values: `mode`, `traceId`, `storage`.

- [x] **Task 2.5 Implement REPLAY initialization in `run` using cassette load** — `feat(context): call cassette.loadTrace once per REPLAY run before callback scope`
  - **Test**: in REPLAY, `storage.loadTrace(traceId)` called once per run.

- [x] **Task 2.6 Seed matcher records in REPLAY branch** — `feat(context): seed replay matcher with loaded records before callback scope`
  - **Test**: active matcher receives loaded records before callback logic executes.

- [x] **Task 2.7 Keep CAPTURE branch read-free** — `test(context): assert CAPTURE run does not call cassette.loadTrace`
  - **Test**: in CAPTURE, `storage.loadTrace` is never called.

- [x] **Task 2.8 Cleanup outdated `runWithContext` adapter behavior after `run(options, fn)` refactor** — `refactor(api): preserve legacy replay context fields while adapting to run options`
  - **Test**: `runWithContext` preserves legacy replay context fields (`cassettePath`, strict flags) and seeds matcher/inbound record from cassette path before callback execution.

- [x] **Task 2.9 Remove legacy `runWithContext` API and migrate callers to `SoftprobeContext.run`** — `refactor(api): remove runWithContext and migrate replay scopes to SoftprobeContext.run helper`
  - **Test**: `softprobe` public API has no `runWithContext`; existing replay test scopes use `SoftprobeContext.run`.

---

## 3) Cassette Runtime (`design-cassette.md`) — Atomic

- [x] **Task 3.1 Implement `NdjsonCassette.loadTrace` adapter** — `feat(cassette): add NdjsonCassette loadTrace adapter with traceId fixture test`
  - **Test**: fixture NDJSON returns only matching trace records.

- [x] **Task 3.2 Implement `NdjsonCassette.saveRecord` adapter** — `feat(cassette): add NdjsonCassette saveRecord append-line adapter with unit test`
  - **Test**: one record append results in one NDJSON line.

- [x] **Task 3.3 Implement optional `NdjsonCassette.flush` passthrough** — `feat(cassette): add NdjsonCassette flush passthrough to optional writer hook`
  - **Test**: delegates to underlying queue/store flush when available.

- [x] **Task 3.4 Add context-aware capture write helper** — `feat(cassette): add context capture write helper using active trace and cassette`
  - **Test**: in CAPTURE mode, helper calls `getCassette().saveRecord(getTraceId(), record)`.

- [x] **Task 3.5 Add context-aware flush helper** — `feat(cassette): add context-aware flush helper with optional cassette flush passthrough`
  - **Test**: helper calls `cassette.flush?.()` and safely no-ops when undefined.

---

## 4) Matcher Runtime (`design-matcher.md`) — Atomic

- [x] **Task 4.1 Verify `SoftprobeMatcher` chain contract** — `test(matcher): verify first non-CONTINUE short-circuits matcher chain`
  - **Test**: first non-`CONTINUE` action wins; all-continue returns `CONTINUE`.

- [x] **Task 4.2 Implement/confirm default matcher key extraction from span bindings** — `test(matcher): confirm deterministic key extraction for postgres/redis/http span bindings`
  - **Test**: postgres/redis/http spans map to deterministic `(protocol, identifier)` keys.

- [x] **Task 4.3 Implement/confirm default matcher candidate filter + sequence policy** — `feat(matcher): consume per-key outbound candidates in deterministic order without wrap-around`
  - **Test**: repeated identical outbound calls consume deterministic sequence order.

- [x] **Task 4.4 Implement optional topology matcher** — `test(matcher): verify topology matcher beats flat ordering when parent span disambiguates`
  - **Test**: when parent span name disambiguates candidates, topology choice is preferred over flat pool.

- [x] **Task 4.5 Keep strict-mode policy out of matcher layer** — `fix(matcher): return CONTINUE when topology pool is exhausted to keep strict policy in wrappers`
  - **Test**: no-match from matcher returns `CONTINUE`; wrapper decides strict/dev behavior.

---

## 5) Middleware Entry Points — Atomic

- [x] **Task 5.1 Express middleware uses `SoftprobeContext.run(options, next)`** — `refactor(express): run middleware scope via SoftprobeContext.run with mode/traceId/storage`
  - **Test**: downstream handler observes active `mode`, `traceId`, `storage`.

- [x] **Task 5.2 Fastify plugin uses `SoftprobeContext.run(options, handler)`** — `refactor(fastify): scope onRequest via SoftprobeContext.run with mode/traceId/storage`
  - **Test**: route handler observes active `mode`, `traceId`, `storage`.

- [x] **Task 5.3 Remove `cassettePath` from `SoftprobeContext` stored/runtime interface and public getter API** — `refactor(context): remove cassettePath API and resolve storage only from header or configured cassette`
  - **Test**: `SoftprobeContext.active()` shape/getters expose cassette via `storage` only; `SoftprobeContext.getCassettePath()` is removed; no runtime `cassettePath` field/getter usage remains in middleware/wrappers.

- [x] **Task 5.4 Header coordination overrides defaults via run options** — `fix(context): normalize x-softprobe header values from string arrays for run-scoped overrides`
  - **Test**: request `x-softprobe-*` values are reflected in active context.

---

## 6) Wrapper/Interceptor Alignment — Atomic

- [x] **Task 6.1 Postgres replay wrapper reads matcher from active context only** — `refactor(replay-postgres): source matcher from active SoftprobeContext only (no global fallback)`
  - **Test**: replay mock works without global matcher fallback mutation.

- [x] **Task 6.2 Redis replay wrapper reads matcher from active context only** — `refactor(replay-redis): source matcher from active SoftprobeContext only (no global fallback)`
  - **Test**: replay mock works with context-seeded matcher records.

- [x] **Task 6.3 HTTP replay interceptor reads matcher from active context only** — `refactor(replay-http): source matcher from active SoftprobeContext only (no global fallback)`
  - **Test**: replay handler returns mocked response using context matcher state.

- [x] **Task 6.4 Wrapper strict/dev behavior remains wrapper-owned** — `fix(replay-wrappers): enforce strict no-match failures and dev passthroughs in wrapper layer`
  - **Test**: strict mode hard-fails on `CONTINUE`; dev mode passthroughs.

- [x] **Task 6.5 Capture hooks write through context cassette helper** — `refactor(capture-hooks): route inbound/outbound capture writes through context cassette helper with active trace ids`
  - **Test**: inbound/outbound capture paths call cassette save with active trace id.

---

## 7) API Surface Migration — Atomic

- [x] **Task 7.1 Remove/replace legacy `ReplayContext` and `cassettePath`-based run API** — `refactor(api): replace getReplayContext with getContext and expose softprobe.run with SoftprobeRunOptions`
  - **Test**: public API compiles with `SoftprobeRunOptions` (`storage`, not `cassettePath`).

- [x] **Task 7.2 Remove legacy context shape assumptions in getters** — `refactor(api): compose getContext from SoftprobeContext getters and drop legacy cassettePath shape assumptions`
  - **Test**: API getters delegate to `SoftprobeContext` new fields only.

- [x] **Task 7.3 Remove global replay matcher fallback path** — `refactor(context): remove getMatcher global/baggage fallback and keep matcher sourcing context-only`
  - **Test**: replay behavior remains green with matcher sourced from active context.

---

## 8) Init/Boot Wiring — Atomic

- [x] **Task 8.1 Construct `NdjsonCassette` in boot path** — `test(init): verify boot constructs NdjsonCassette from configured cassette path and passes it as storage`
  - **Test**: init creates cassette from configured NDJSON path.

- [x] **Task 8.2 Pass cassette instance into middleware/context run entry points** — `test(middleware): assert Express/Fastify request scopes receive the same boot-configured cassette instance`
  - **Test**: request path receives same cassette object from boot wiring.

- [x] **Task 8.3 Keep import-order safety before OTel wrapper activation** — `test(init): enforce boot-time import-order guard for pre-wrapped pg in replay mode and tag softprobe wrappers for safe idempotency`
  - **Test**: guard still throws when dependency module was wrapped before softprobe init.

---

## 9) Regression + E2E Coverage — Atomic

- [x] **Task 9.1 Capture E2E writes inbound+outbound NDJSON via cassette interface** — `test(e2e): stabilize task 9.1 capture cassette flow with local outbound target`
  - **Test**: recorded file contains expected trace-scoped records.

- [x] **Task 9.2 Replay E2E runs with dependencies offline** — `test(e2e): add strict offline replay coverage across http/postgres/redis`
  - **Test**: strict replay succeeds for recorded paths without live DB/Redis/HTTP.

- [x] **Task 9.3 Strict negative E2E for unrecorded call** — `test(e2e): add strict negative replay coverage with network probe no-hit assertion`
  - **Test**: unrecorded outbound call fails deterministically and does not hit network.

---

## 10) Docs + Consistency Cleanup — Atomic

- [x] **Task 10.1 Update README snippets to `run({ mode, storage, traceId }, fn)`** — `test(docs): add README API snippet guard and migrate quick-start replay example`
  - **Test**: grep/snapshot check contains no stale `cassettePath` API examples for new flow.

- [x] **Task 10.2 Remove stale legacy wording across docs/comments** — `test(docs): add legacy wording grep guard and migrate example task docs to run API`
  - **Test**: grep check for removed legacy terms (e.g., deprecated context API names) in active docs.

- [x] **Task 10.3 Keep design links consistent with `design-*.md` convention** — `test(docs): add design link checks and wire README docs to focused design specs`
  - **Test**: link check for `design.md`, `design-context.md`, `design-cassette.md`, `design-matcher.md`.

---

## 11) E2E Hardening for Real Capture/Replay + YAML Config — Atomic

> User-approved exception for this phase: these are test-focused tasks and may be implemented without strict Red/Green ceremony.

- [x] **Task 11.1 Replace synthetic HTTP capture with true outbound interception E2E** — `test(e2e): switch HTTP capture worker to real local fetch interception and assert recorded body fidelity`
  - **Problem**: current HTTP capture worker invokes capture hook directly instead of executing a real outbound call through runtime instrumentation.
  - **Test**: in CAPTURE mode, worker performs a real `fetch` to a local probe server; cassette must contain outbound `http` record whose `identifier`, `statusCode`, and `responsePayload.body` match probe response.
  - **Solution**:
    - add a dedicated local HTTP probe worker (`/payload`, deterministic JSON response).
    - update `http-cassette-capture-worker.ts` to make an actual network call (no direct hook invocation).
    - keep dependency local-only to avoid flaky external services.

- [ ] **Task 11.2 Add replay injection assertion for HTTP payload/body fidelity**
  - **Problem**: HTTP replay E2E currently asserts mainly status success; payload injection fidelity is not enforced.
  - **Test**: replay response body must equal recorded `responsePayload.body` for the same trace/identifier.
  - **Solution**:
    - extend `http-cassette.e2e.test.ts` to parse replay JSON and compare full payload (not only status).
    - assert deterministic fields from cassette (`url`, `method`, custom marker field).

- [ ] **Task 11.3 Add YAML-driven boot E2E (no mode/cassette env overrides)**
  - **Problem**: E2E primarily configures mode/path via env vars; YAML boot path is not validated end-to-end.
  - **Test**:
    - CAPTURE scenario: worker uses `SOFTPROBE_CONFIG_PATH` pointing to YAML with `mode: CAPTURE` and `cassettePath`, writes cassette.
    - REPLAY scenario: worker uses `SOFTPROBE_CONFIG_PATH` YAML with `mode: REPLAY` and same cassette, succeeds offline without `SOFTPROBE_MODE`/`SOFTPROBE_CASSETTE_PATH`.
  - **Solution**:
    - create temporary per-test YAML fixture files.
    - add E2E workers that only import `init` and rely on config manager path.
    - assert env vars for mode/path are unset in child process input.

- [ ] **Task 11.4 Prove strict replay network isolation for recorded positive path**
  - **Problem**: negative path has no-hit probe assertion; positive recorded path does not explicitly prove passthrough was avoided.
  - **Test**: in strict replay for a recorded call, response succeeds and probe server hit count remains `0`.
  - **Solution**:
    - record against local probe in capture phase.
    - stop/replace dependency in replay phase and verify replay still succeeds.
    - query probe `/hits` after replay to confirm no live outbound execution.

- [ ] **Task 11.5 Remove test-only matcher/store bootstrapping from replay workers**
  - **Problem**: some replay workers manually load records/matcher, bypassing canonical context run + cassette load path.
  - **Test**: replay workers must succeed using only production APIs (`init`, middleware/context entry, `softprobe.run`) with no direct `setReplayRecordsCache` or custom matcher injection.
  - **Solution**:
    - refactor replay workers to rely on `SoftprobeContext.run` with `NdjsonCassette` where needed.
    - disallow direct calls to `loadNdjson` + synthetic span conversion in those workers.
    - keep assertions focused on behavior parity with runtime boot flow.

- [ ] **Task 11.6 Remove legacy env->YAML compatibility bridge in E2E launcher**
  - **Problem**: `run-child` currently translates legacy `SOFTPROBE_*` env vars into generated YAML, which hides non-YAML call sites and weakens strict YAML-only enforcement.
  - **Test**: all E2E entry points pass `SOFTPROBE_CONFIG_PATH` explicitly; `run-child` no longer accepts/rewrites `SOFTPROBE_MODE`/`SOFTPROBE_CASSETTE_PATH`/strict env flags.
  - **Solution**:
    - remove legacy env translation logic from `run-child.ts`.
    - update each E2E test setup to create and pass explicit YAML config files.
    - fail fast in helpers when `SOFTPROBE_CONFIG_PATH` is missing.

- [ ] **Task 11.7 Define and enforce an E2E coverage matrix to reduce duplication**
  - **Problem**: overlapping E2E cases increase runtime and maintenance while obscuring the minimum required guarantees per framework/protocol/mode.
  - **Test**: matrix document/check maps each required scenario to exactly one primary E2E test (`capture`, `replay-offline`, `strict-negative`, `yaml-boot`) per framework/protocol.
  - **Solution**:
    - add a concise matrix in `tasks.md` or dedicated test README.
    - merge/remove duplicate scenarios once matrix coverage is confirmed.
    - keep only one canonical test per guarantee plus minimal parity checks.

- [ ] **Task 11.8 Introduce shared E2E assertions/helpers across Express/Fastify parity flows**
  - **Problem**: similar assertions are duplicated between Express and Fastify E2E files, making drift/regressions more likely.
  - **Test**: both framework suites reuse shared assertion helpers for cassette record validation and replay response parity.
  - **Solution**:
    - extract shared assertion utilities under `src/__tests__/e2e/helpers/`.
    - keep framework-specific setup isolated, but centralize validation logic.
    - ensure behavior parity is asserted consistently across both frameworks.

---

## Done Criteria (V6)

- `SoftprobeContext.run(options, fn)` is the single scoped execution API.
- Context stores `storage: Cassette` (no `cassettePath` in runtime context contract).
- Replay loads records via cassette and seeds matcher in active context.
- Capture writes records through cassette interface from active context.
- Matchers remain pure selection logic; strict/dev behavior remains in wrappers.
- Docs and examples use `design-*.md` naming and new API shape.
