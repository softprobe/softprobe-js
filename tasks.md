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

- [x] **Task 11.2 Add replay injection assertion for HTTP payload/body fidelity** — `test(e2e): assert replay body equals recorded cassette payload with deterministic url/method marker fields`
  - **Problem**: HTTP replay E2E currently asserts mainly status success; payload injection fidelity is not enforced.
  - **Test**: replay response body must equal recorded `responsePayload.body` for the same trace/identifier.
  - **Solution**:
    - extend `http-cassette.e2e.test.ts` to parse replay JSON and compare full payload (not only status).
    - assert deterministic fields from cassette (`url`, `method`, custom marker field).

- [x] **Task 11.3 Add YAML-driven boot E2E (no mode/cassette env overrides)** — `test(e2e): assert capture/replay YAML boot works with SOFTPROBE_CONFIG_PATH only and legacy mode/cassette env vars unset in child workers`
  - **Problem**: E2E primarily configures mode/path via env vars; YAML boot path is not validated end-to-end.
  - **Test**:
    - CAPTURE scenario: worker uses `SOFTPROBE_CONFIG_PATH` pointing to YAML with `mode: CAPTURE` and `cassettePath`, writes cassette.
    - REPLAY scenario: worker uses `SOFTPROBE_CONFIG_PATH` YAML with `mode: REPLAY` and same cassette, succeeds offline without `SOFTPROBE_MODE`/`SOFTPROBE_CASSETTE_PATH`.
  - **Solution**:
    - create temporary per-test YAML fixture files.
    - add E2E workers that only import `init` and rely on config manager path.
    - assert env vars for mode/path are unset in child process input.

- [x] **Task 11.4 Prove strict replay network isolation for recorded positive path** — `test(e2e): assert replay returns recorded payload against replacement probe server and tagged probe hit count stays zero`
  - **Problem**: negative path has no-hit probe assertion; positive recorded path does not explicitly prove passthrough was avoided.
  - **Test**: in strict replay for a recorded call, response succeeds and probe server hit count remains `0`.
  - **Solution**:
    - record against local probe in capture phase.
    - stop/replace dependency in replay phase and verify replay still succeeds.
    - query probe `/hits` after replay to confirm no live outbound execution.

- [x] **Task 11.5 Remove test-only matcher/store bootstrapping from replay workers** — `refactor(e2e): replay workers use NdjsonCassette only; context preserves empty traceId; loadNdjson supports empty traceId`
  - **Problem**: some replay workers manually load records/matcher, bypassing canonical context run + cassette load path.
  - **Test**: replay workers must succeed using only production APIs (`init`, middleware/context entry, `softprobe.run`) with no direct `setReplayRecordsCache` or custom matcher injection.
  - **Solution**:
    - refactor replay workers to rely on `SoftprobeContext.run` with `NdjsonCassette` where needed.
    - disallow direct calls to `loadNdjson` + synthetic span conversion in those workers.
    - keep assertions focused on behavior parity with runtime boot flow.

- [ ] **Task 11.6 Remove legacy env->YAML compatibility bridge in E2E launcher**
  - **Problem**: `run-child` currently translates legacy `SOFTPROBE_*` env vars into generated YAML, which hides non-YAML call sites and weakens strict YAML-only enforcement.
  - **Test**: all E2E entry points pass `SOFTPROBE_CONFIG_PATH` explicitly; `run-child` no longer accepts/rewrites `SOFTPROBE_MODE`/`SOFTPROBE_CASSETTE_PATH`/`SOFTPROBE_CASSETTE_DIRECTORY`/strict env flags (align with section 13: config uses cassetteDirectory).
  - **Solution**:
    - remove legacy env translation logic from `run-child.ts`.
    - update each E2E test setup to create and pass explicit YAML config files (with `cassetteDirectory` when section 13 is in effect).
    - fail fast in helpers when `SOFTPROBE_CONFIG_PATH` is missing.

- [ ] **Task 11.7 Define and enforce an E2E coverage matrix to reduce duplication**
  - **Problem**: overlapping E2E cases increase runtime and maintenance while obscuring the minimum required guarantees per framework/protocol/mode.
  - **Test**: matrix document/check maps each required scenario to exactly one primary E2E test (`capture`, `replay-offline`, `strict-negative`, `yaml-boot`) per framework/protocol.
  - **Solution**:
    - add a concise matrix in `tasks.md` or dedicated test README.
    - merge/remove duplicate scenarios once matrix coverage is confirmed.
    - keep only one canonical test per guarantee plus minimal parity checks.
  - **Note**: After section 13 (Cassette V2), E2E setup uses `cassetteDirectory` and per-trace files `{cassetteDirectory}/{traceId}.ndjson`; matrix and scenarios should reflect that.

- [ ] **Task 11.8 Introduce shared E2E assertions/helpers across Express/Fastify parity flows**
  - **Problem**: similar assertions are duplicated between Express and Fastify E2E files, making drift/regressions more likely.
  - **Test**: both framework suites reuse shared assertion helpers for cassette record validation and replay response parity.
  - **Solution**:
    - extract shared assertion utilities under `src/__tests__/e2e/helpers/`.
    - keep framework-specific setup isolated, but centralize validation logic.
    - ensure behavior parity is asserted consistently across both frameworks.
  - **Note**: After section 13 (Cassette V2), cassette assertions read from `{cassetteDirectory}/{traceId}.ndjson` or via context’s cassette; shared helpers should align with that (no standalone loadNdjson).

---

## Done Criteria (V6)

- `SoftprobeContext.run(options, fn)` is the single scoped execution API.
- Context stores `storage: Cassette` (no `cassettePath` in runtime context contract).
- Replay loads records via cassette and seeds matcher in active context.
- Capture writes records through cassette interface from active context.
- Matchers remain pure selection logic; strict/dev behavior remains in wrappers.
- Docs and examples use `design-*.md` naming and new API shape.

**Section 13 (Cassette V2)** adds: config uses `cassetteDirectory` only; init does not create a global cassette; cassette created only in SoftprobeContext per traceId; one file per trace; Cassette interface without traceId parameters; cassette is mode-agnostic. Open tasks in sections 11 and 12 are written to align with section 13 when implemented.

---

## 12) Basic Example Simplification + YAML/Header Replay Demo (User-Directed, No TDD) — Atomic

> User-approved exception for this phase: example/demo cleanup may be implemented without strict Red/Green ceremony.
> Execution remains strictly sequential: only work the first unchecked task.

- [ ] **Task 12.1 Define canonical example flow (YAML CAPTURE boot + CLI header REPLAY switch)**
  - **Problem**: current example documents mixed flows (env REPLAY boot, runners, multiple scripts), making the intended replay mechanism unclear.
  - **Acceptance**:
    - one canonical flow is documented:
      1) app starts with YAML `mode: CAPTURE` and `cassetteDirectory` (per design-cassette.md; after section 13 no single cassette path in config).
      2) capture request writes cassette (one file per trace under the directory).
      3) replay test uses `softprobe diff` which switches request to REPLAY via headers.
    - docs explicitly state that mode and cassetteDirectory come from YAML config, not `SOFTPROBE_MODE`/`SOFTPROBE_CASSETTE_PATH`/`SOFTPROBE_CASSETTE_DIRECTORY`.
  - **Solution**:
    - add/update example YAML config files for the canonical flow (use cassetteDirectory when section 13 is in effect).
    - remove contradictory wording from `examples/basic-app/README.md`.

- [ ] **Task 12.2 Remove legacy replay bootstrapping from basic app runtime**
  - **Problem**: `examples/basic-app/run.ts` manually primes replay cache/matcher globals, adding complexity and diverging from context-driven runtime flow.
  - **Acceptance**:
    - no manual replay priming in `run.ts` (no direct `loadNdjson`, `setReplayRecordsCache`, `setGlobalReplayMatcher`); cassette is created only in SoftprobeContext (see Task 13.6 / 13.10).
    - app runtime still supports capture and header-driven replay test requests through existing middleware/context flow.
  - **Solution**:
    - delete manual replay setup block and related imports.
    - keep route logic focused on business behavior only.

- [ ] **Task 12.3 Consolidate scripts to one canonical capture+replay test path**
  - **Problem**: overlapping scripts/runners obscure how users should run the example.
  - **Acceptance**:
    - `test-with-capture-replay.sh` becomes canonical:
      - starts app via `SOFTPROBE_CONFIG_PATH` (capture YAML with `cassetteDirectory` per section 13),
      - sends capture request with trace headers (`traceparent`, `x-softprobe-trace-id`),
      - flushes capture output,
      - runs `softprobe diff` for replay validation (header mode switching; diff uses cassette directory + traceId when section 13 is in effect).
    - `package.json` example scripts point to canonical flow.
  - **Solution**:
    - refactor shell script to YAML-only startup.
    - update script comments and package script wiring for clarity.

- [ ] **Task 12.4 Add business-regression demonstration (not mocking-focused)**
  - **Problem**: current mismatch explanations center on tracing/header nondeterminism rather than real business output changes.
  - **Acceptance**:
    - example includes an optional business bug toggle path (for demo) where response semantics change and `softprobe diff` fails deterministically.
    - docs explain this as regression detection in app logic (not upstream tracing variance).
  - **Solution**:
    - add a small, explicit business-field toggle in `run.ts` (example-only).
    - document “capture baseline -> enable bug -> diff fails” workflow.

- [ ] **Task 12.5 Remove checked-in example NDJSON artifacts**
  - **Problem**: committed cassette artifacts create stale replay inputs and hide whether capture actually ran.
  - **Acceptance**:
    - remove checked-in NDJSON files (or cassette directory contents) under `examples/basic-app/`.
    - example flow reuses the freshly captured output for replay in the same run (after section 13: per-trace files under cassetteDirectory).
    - README/scripts clearly indicate cassette output is generated by capture step.
  - **Solution**:
    - delete existing example NDJSON files / cassette artifacts.
    - ensure script creates/verifies cassette output before replay step.

- [ ] **Task 12.6 Reduce example surface area in docs**
  - **Problem**: too many entry points (`capture-runner`, `replay-runner`, replay-only shell) increase cognitive load for basic onboarding.
  - **Acceptance**:
    - README presents one primary path and one optional “regression demo” path only.
    - redundant runners/scripts are either removed or explicitly marked non-canonical/internal.
  - **Solution**:
    - trim file table and command list to canonical scripts.
    - align wording with YAML-only + header-driven replay approach.

---

## 13) Cassette Design V2 (directory, per-request, mode-agnostic) — Atomic

> Implements [design-cassette.md](design-cassette.md) as updated: cassette directory (not file), no global cassette in init, cassette created only inside SoftprobeContext per request/traceId, one file per trace, Cassette interface without traceId parameters, cassette is pure read/write (no mode awareness).

- [x] **Task 13.1 Config: cassette directory instead of file path** — `feat(config): add cassetteDirectory to config and context; init uses it and does not pass single file path when set`
  - **Goal**: Configure a cassette directory; no single global cassette file path in config.
  - **Test**: Config schema/type exposes `cassetteDirectory` (or equivalent); init reads and stores `cassetteDirectory`; no `cassettePath` used for determining where to read/write cassette files. Unit test or init-boot test asserts init does not receive or pass a single file path for the default cassette store.
  - **Solution**: Add `cassetteDirectory` to config type and ConfigManager; init calls `SoftprobeContext.initGlobal({ ..., cassetteDirectory })` (or equivalent); remove or repurpose `cassettePath` in config so that runtime cassette file paths are always derived as `{cassetteDirectory}/{traceId}.ndjson`.

- [x] **Task 13.2 Init does not create or set a global cassette** — `refactor(init): remove all cassette construction, setCaptureStore, and REPLAY eager load; init only sets mode, cassetteDirectory, strict flags`
  - **Goal**: Init never instantiates a Cassette or sets global storage; init only sets mode, cassetteDirectory, and strict flags.
  - **Test**: In CAPTURE, REPLAY, and PASSTHROUGH modes, init does not call `new NdjsonCassette(...)` (or any cassette constructor) and does not set a global `storage`/cassette on the context. Init-boot test mocks or asserts no cassette instance is created at boot; only directory and mode are stored for use when SoftprobeContext is created per request.
  - **Solution**: Remove from init all cassette construction and `setCaptureStore`/global storage assignment; remove REPLAY eager load of cassette file. Init only sets config-derived values (mode, cassetteDirectory, strictReplay, strictComparison) on the global default or config holder used by SoftprobeContext.
  - **Note**: E2E capture/replay tests fail until Task 13.5 (get-or-create cassette per traceId) and middleware use context-provided storage.

- [x] **Task 13.3 Cassette interface: loadTrace() and saveRecord(record) without traceId** — `feat(cassette): Cassette.loadTrace() and saveRecord(record) with no traceId param; cassette bound to one trace`
  - **Goal**: Cassette is bound to one traceId at creation; interface does not take traceId in load or save.
  - **Test**: Type or compile-time assertion: `Cassette` has `loadTrace(): Promise<SoftprobeCassetteRecord[]>` and `saveRecord(record: SoftprobeCassetteRecord): Promise<void>` (no traceId parameter). Unit test that a mock cassette is called with these signatures (e.g. context.run in REPLAY calls `cassette.loadTrace()` with no args; capture helper calls `cassette.saveRecord(record)` with one arg).
  - **Solution**: Update `Cassette` in types/schema to the new signatures; update NdjsonCassette, context.run, saveCaptureRecordFromContext, and any other call sites to use `loadTrace()` and `saveRecord(record)`; remove traceId from Cassette method parameters.

- [x] **Task 13.4 One file per trace: NdjsonCassette path = {cassetteDirectory}/{traceId}.ndjson** — `feat(cassette): NdjsonCassette(cassetteDirectory, traceId); path = {dir}/{traceId}.ndjson`
  - **Goal**: Each cassette instance is backed by a single file path derived from directory and traceId; one NDJSON file per trace.
  - **Test**: Unit test: given a temp directory and traceId, NdjsonCassette (or the factory that creates it) uses the path `{dir}/{traceId}.ndjson` for both read and write; writing a record and calling loadTrace() returns that record; a different traceId produces a different file path and does not see the first trace's data.
  - **Solution**: NdjsonCassette (or internal factory) is constructed with cassetteDirectory and traceId; internal path is path.join(cassetteDirectory, traceId + '.ndjson') or equivalent; loadTrace() reads that file; saveRecord(record) appends to that file.

- [ ] **Task 13.5 SoftprobeContext get-or-create cassette per traceId**
  - **Goal**: When SoftprobeContext is created for a request/session (e.g. in run() or middleware), the cassette for that traceId is get-or-created; the same instance is reused for the same traceId (e.g. on withData/fromHeaders updates).
  - **Test**: In a test, create or run context twice for the same traceId (and same cassetteDirectory); assert the cassette instance returned by getCassette() is the same (reference equality). Run with a different traceId and assert a different cassette instance (or different backing file). No new cassette instance when only other context fields (e.g. strictReplay) are updated for the same traceId.
  - **Solution**: In the SoftprobeContext creation/run path, maintain a cache keyed by (cassetteDirectory, traceId) or equivalent; when building run options or request context, get or create the cassette for that traceId and attach it to the context; reuse from cache when traceId and directory are unchanged.

- [ ] **Task 13.6 Only SoftprobeContext creates cassette instances**
  - **Goal**: No code path outside SoftprobeContext (or its designated internal factory) instantiates the concrete cassette type (e.g. NdjsonCassette). Init, middleware, and request-storage do not call the cassette constructor.
  - **Test**: Grep or code check: no `new NdjsonCassette` (or cassette factory call) in init.ts, capture/express.ts, capture/fastify.ts, core/cassette/request-storage.ts, or replay helpers; only the context module (or a private factory it uses) creates cassettes. Tests that need a cassette do so via SoftprobeContext.run(..., fn) and getCassette() inside fn, or via a documented test-only helper that creates context/cassette for (directory, traceId) for assertion purposes only.
  - **Solution**: Move all cassette construction into the context layer (or a single factory called only from context); refactor request-storage and middleware to obtain storage from SoftprobeContext (get-or-create by traceId) instead of constructing NdjsonCassette from header path; refactor tests to use run-scoped getCassette() or a test helper; remove store/load-ndjson and store/context-routing-capture-store as needed so that only the context path creates and uses cassettes.

- [ ] **Task 13.7 Cassette and NdjsonCassette have no mode awareness**
  - **Goal**: Cassette interface and implementation are pure read/write storage; no references to CAPTURE, REPLAY, or mode.
  - **Test**: Grep or comment check: in the Cassette type definition and in NdjsonCassette (and any cassette adapter), no string literal or reference to "CAPTURE", "REPLAY", or "mode". Documentation for Cassette describes only load/save/flush semantics.
  - **Solution**: Remove any mode-based logic or comments from Cassette interface and NdjsonCassette; ensure all mode decisions (when to load vs save) live in SoftprobeContext and call sites (e.g. run(), capture helpers).

- [ ] **Task 13.8 Update context-capture and capture hooks to use saveRecord(record) only**
  - **Goal**: Capture write path uses the new Cassette signature; no traceId passed to saveRecord.
  - **Test**: saveCaptureRecordFromContext (and any direct cassette.saveRecord caller) calls `getCassette().saveRecord(record)` with one argument. Unit tests for capture hooks (postgres, redis, undici, http) run inside a context with a mock cassette and assert saveRecord(record) is called with the expected record (no traceId argument).
  - **Solution**: Change saveCaptureRecordFromContext to call `cassette.saveRecord(record)`; update capture hooks that call the cassette to use the same signature; ensure record still contains traceId for the single-trace file.

- [ ] **Task 13.9 Update context.run REPLAY branch to use loadTrace() only**
  - **Goal**: REPLAY path in SoftprobeContext.run() calls cassette.loadTrace() with no arguments.
  - **Test**: In REPLAY run, the cassette attached to options is invoked with loadTrace() (no args) once before the callback; matcher is seeded with the returned records. Unit test spies on the cassette's loadTrace and asserts it was called with zero arguments.
  - **Solution**: In context.ts run() for REPLAY, replace loadTrace(traceId) with loadTrace(); ensure the cassette instance is already bound to the run's traceId so the correct file is read.

- [ ] **Task 13.10 Remove store/load-ndjson and store/context-routing-capture-store; use only Cassette**
  - **Goal**: No standalone loadNdjson or context-routing capture store; all read/write goes through the Cassette interface and SoftprobeContext-created cassettes.
  - **Test**: No imports of load-ndjson or context-routing-capture-store from production code (init, middleware, replay store-accessor, api, etc.); E2E and unit tests that need to read cassette files do so via getCassette() in scope or a test helper that reads `{cassetteDirectory}/{traceId}.ndjson` for assertions. Replay store-accessor (if still needed) obtains records via context's cassette or a single internal path that uses the cassette factory for the given path/directory+traceId.
  - **Solution**: Delete store/load-ndjson.ts and store/context-routing-capture-store.ts. Move any necessary stream-read logic into the cassette layer (internal to NdjsonCassette or its factory). Refactor loadReplayRecordsFromPath, CLI diff, E2E assertions, and examples to use SoftprobeContext.run + getCassette().loadTrace() or a test-only file read for `{dir}/{traceId}.ndjson`. Remove getCaptureStore/setCaptureStore and all capture store fallbacks; capture uses only saveCaptureRecordFromContext with context's cassette.

- [ ] **Task 13.11 Restore E2E capture/replay tests broken by Task 13.2**
  - **Problem**: After Task 13.2 (init does not create or set a global cassette), 15 E2E tests fail because they assume a global capture store and/or REPLAY eager load. Capture does not write; replay has no storage; workers and middleware have no cassette.
  - **Prerequisite**: Tasks 13.5 (get-or-create cassette per traceId) and 13.6 (only SoftprobeContext creates cassettes) must be done so middleware receives storage from context.
  - **Goal**: All E2E capture/replay tests pass again. Tests use cassetteDirectory and per-trace files `{cassetteDirectory}/{traceId}.ndjson`; no reliance on global setCaptureStore or loadNdjson at boot.
  - **Test**: Full test suite passes. Affected E2E (e.g. task-9-2-replay-offline, http-cassette, redis-cassette, postgres-cassette-capture, express-inbound-capture, express-inbound-replay, fastify-inbound-cassette, server-inbound-strict-negative, task-9-3-strict-negative) pass with YAML config using cassetteDirectory; capture writes to per-trace files; replay loads from context cassette.
  - **Solution**: Ensure middleware and E2E workers build run options with storage from SoftprobeContext get-or-create (cassetteDirectory + traceId). Update E2E test setup to use cassetteDirectory in config and assert files at `{cassetteDirectory}/{traceId}.ndjson`. Remove or replace any E2E use of cassettePath, getCaptureStore, or loadNdjson for production code paths.

**Done criteria (Cassette V2):** Config uses cassetteDirectory only; init does not create a global cassette; Cassette has loadTrace() and saveRecord(record) with no traceId; one file per trace; only SoftprobeContext creates cassette instances; cassette is mode-agnostic; no store/load-ndjson or context-routing-capture-store in production paths.
