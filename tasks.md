# Softprobe Implementation Tracker

**Current Status:** In Progress

## Phase 1: Foundation & Types
- [x] **Task 1.1: Project Initialization.** * *Action:* Initialize `package.json`, install TypeScript, Jest, and core dependencies (`shimmer`, `undici`, `@opentelemetry/api`, `@opentelemetry/sdk-trace-base`). Configure `jest.config.js` and `tsconfig.json`.
  * *Test:* `npm run test` should execute a dummy test successfully. *(chore: init package, tsconfig, jest, dummy test)*
- [x] **Task 1.2: Schema Definitions.**
  * *Action:* Create `src/types/schema.ts`. Implement the `SoftprobeAttributes`, `SoftprobeTraceStore`, and `MatchRequest` interfaces as defined in the ADD.
  * *Test:* TypeScript compilation (`tsc --noEmit`) passes. *(feat: add schema types, schema.test.ts)*

## Phase 2: The Core Engine (Semantic Matcher)
*Note: We build the brain BEFORE we build the interceptors.*
- [x] **Task 2.1: SemanticMatcher Shell.**
  * *Action:* Create `src/replay/matcher.ts`. Implement the `SemanticMatcher` class with a constructor that takes `ReadableSpan[]` and an empty `findMatch(request: MatchRequest)` method throwing "Not Implemented".
  * *Test:* Instantiate the class in a test file and expect it to throw the correct error. *(feat: SemanticMatcher shell, findMatch throws Not Implemented)*
- [x] **Task 2.2: Flat Matching Logic.**
  * *Action:* Update `findMatch` to filter recorded spans by exact `protocol` and `identifier` match. Return the parsed `softprobe.response.body`.
  * *Test:* Provide a mock array of 2 spans. Request one by identifier. Assert the correct response body is returned. *(feat: flat match by protocol+identifier, return parsed response body)*
- [x] **Task 2.3: Lineage/Tree Matching Heuristic.**
  * *Action:* Update `findMatch` to resolve the current active OpenTelemetry span context. Find the candidate span whose parent matches the live parent's name.
  * *Test:* Create a mock trace tree (Parent -> Child). Mock the active OTel context. Assert the matcher selects the correct child span based on the parent lineage. *(feat: lineage/tree matching via OTel active span and parent name)*
- [x] **Task 2.4: Deduplication & Sequential Execution.**
  * *Action:* Implement `callSequenceMap`. If multiple spans match the lineage, return them sequentially based on how many times the live request has been made.
  * *Test:* Provide 3 identical mock spans. Call `findMatch` 3 times. Assert it returns span 1, then 2, then 3. *(feat: callSequenceMap for N+1 sequential resolution)*
- [x] **Task 2.5: User Overrides (Custom Matchers).**
  * *Action:* Add `customMatchers` array and `addMatcher` method. Ensure custom matchers evaluate *before* default tree matching.
  * *Test:* Register a custom matcher that returns `{ action: 'MOCK', payload: 'override' }`. Assert `findMatch` returns 'override' instead of the recorded span. *(feat: customMatchers, addMatcher, MatcherResult/CustomMatcherFn; custom matchers run before tree match)*

## Phase 3: Global State Management
- [x] **Task 3.1: AsyncLocalStorage Trace Isolation.**
  * *Action:* Create `src/api.ts`. Implement `softprobe.setReplayContext({ traceId })` using Node's `AsyncLocalStorage` to ensure concurrent tests don't share matcher state.
  * *Test:* Run two async functions concurrently using different `traceId` contexts. Assert each retrieves only their specific context. *(feat: api.ts with ALS, runWithContext/getReplayContext/setReplayContext/clearReplayContext)*

## Phase 4: Capture Mode (OTel Hooks)

Capture and replay are **implemented in pairs per protocol** (see design §3.1). For each protocol, complete the capture task before the corresponding replay task in Phase 5 so identifier and payload semantics stay aligned. Capture hooks live in per-protocol modules (`src/capture/postgres.ts`, `undici.ts`, `redis.ts`) with a shared `inject.ts`; the mutator applies them via `applyAutoInstrumentationMutator`. Contract alignment is documented in design §5.3 and validated in E2E (Phase 7: tasks 7.2–7.5).

- [x] **Task 4.1: Custom Span Exporter.**
  * *Action:* Create `src/capture/exporter.ts`. Implement `SoftprobeTraceExporter` that writes spans to `softprobe-traces.json`.
  * *Test:* Pass mock spans to `.export()`. Assert the JSON file is created and contains the serialized spans. *(feat: SoftprobeTraceExporter, serializeSpan, optional filePath)*
- [x] **Task 4.2: Auto-Instrumentation Mutator – Postgres.** *(pair: Task 5.1)*
  * *Action:* Create `src/capture/mutator.ts`. Use `shimmer` to wrap `getNodeAutoInstrumentations`. Inject the `responseHook` for Postgres.
  * *Test:* Call the wrapped function. Assert the returned config object contains our custom `responseHook` for `@opentelemetry/instrumentation-pg`.
  * *(feat: mutator.ts, applyAutoInstrumentationMutator, inject Postgres responseHook; mutator.test.ts)*
- [x] **Task 4.3: NodeSDK Hijack.** *(feat: init.ts, initCapture wraps NodeSDK.start, registers SoftprobeTraceExporter)*
  * *Action:* Create `src/capture/init.ts`. Use `shimmer` on `NodeSDK.prototype.start` to inject the `SoftprobeTraceExporter` into the span processor pipeline.
  * *Test:* Instantiate a mock NodeSDK and call start. Assert our exporter was registered internally.
- [x] **Task 4.4: Mutator – HTTP/Undici responseHook.** *(pair: Task 5.2)* *(feat: inject responseHook for @opentelemetry/instrumentation-undici, set softprobe.protocol/identifier/request/response body)*
  * *Action:* Extend mutator to inject `responseHook` for HTTP/undici instrumentation. Set `softprobe.protocol: 'http'`, identifier (e.g. method + URL), and request/response body on spans per design §3.1.
  * *Test:* Call wrapped `getNodeAutoInstrumentations`. Assert HTTP/undici instrumentation has our responseHook; (optional) assert hook sets softprobe attributes on a mock span.
- [x] **Task 4.5: Mutator – Redis responseHook.** *(pair: Task 5.3)* *(feat: inject responseHook for @opentelemetry/instrumentation-redis-4, set softprobe.* attributes)*
  * *Action:* Extend mutator to inject `responseHook` for Redis instrumentation. Set `softprobe.protocol: 'redis'`, identifier (command + key/args), and request/response on spans per design §3.1.
  * *Test:* Call wrapped `getNodeAutoInstrumentations`. Assert Redis instrumentation has our responseHook.

## Phase 5: Replay Mode (Monkey Patching)

Each task is the **replay pair** of the same-numbered capture task in Phase 4 (e.g. 5.1 pairs with 4.2). Use the same `protocol` and identifier semantics as capture so the matcher can resolve live calls to recorded spans.

- [x] **Task 5.1: Postgres Replay.** *(pair: Task 4.2)* *(feat: replay/postgres.ts, shimmer wrap pg.Client.query; api getActiveMatcher + ReplayContext.matcher)*
  * *Action:* Create `src/replay/postgres.ts`. Use `shimmer` on `pg.Client.prototype.query`. Connect it to the SemanticMatcher with `protocol: 'postgres'` and identifier = query text.
  * *Test:* Call `client.query`. Assert it does not hit the network and returns rows from the SemanticMatcher. Throw error if query is unmocked (AC4).
- [ ] **Task 5.2: HTTP Undici Replay.** *(pair: Task 4.4)*
  * *Action:* Create `src/replay/undici.ts`. Setup `MockAgent` (or Dispatcher wrap). Use `softprobe` to get the active SemanticMatcher; resolve requests with `protocol: 'http'`, identifier = method + URL.
  * *Test:* Use `fetch`. Assert the interceptor queries the SemanticMatcher and returns the mocked response.
- [ ] **Task 5.3: Redis Replay.** *(pair: Task 4.5)*
  * *Action:* Create `src/replay/redis.ts`. Patch Redis client (e.g. `send_command` or ioredis). Call matcher with `protocol: 'redis'` and identifier matching capture; return recorded reply.
  * *Test:* Run a Redis command under replay context. Assert no live network and response comes from matcher.

## Phase 6: The Universal Entry Point
- [ ] **Task 6.1: Environment Router.**
  * *Action:* Create `src/init.ts`. Read `process.env.SOFTPROBE_MODE`. Route to capture init, replay init, or do nothing.
  * *Test:* Set env var to 'capture', assert capture init runs. Set to 'replay', assert replay init runs.

## Phase 7: End-to-End Validation

E2E is split so we verify contract alignment and actual request/response (input/output) capture **per protocol** before the full replay flow. Design §5.3. For each supported library (HTTP, Redis, Postgres), one task (7.2, 7.3, 7.4) covers both (1) attribute shape and (2) stored body content for that protocol—so each can be marked done when that protocol's capture and E2E are in place. Task order: fixture (7.1) → per-protocol (7.2, 7.3, 7.4) → replay (7.5).

- [x] **Task 7.1: E2E fixture and capture run.** *(e2e fixture in src/__tests__/e2e/capture-http.e2e.test.ts; initCapture + mutator; fetch; SOFTPROBE_TRACES_FILE)*
  * *Action:* Create a minimal E2E fixture (e.g. `test/e2e/` with a script or small app) that uses Node + OTel SDK + auto-instrumentations and runs in capture mode (`SOFTPROBE_MODE=capture`). Ensure the env router (Task 6.1) and capture init run so that `softprobe-traces.json` is written. The fixture must perform at least one **HTTP** outbound request (e.g. `fetch`). Optionally include Redis and/or Postgres when available.
  * *Test:* Run the fixture in capture mode; assert `softprobe-traces.json` is created and contains at least one trace with spans.

- [x] **Task 7.2: Contract alignment – HTTP (attributes, shape, and body content).** *(assert HTTP spans have softprobe.protocol, identifier, response.body shape; assert stored request/response body match actual content)*
  * *Action:* Using the trace file from 7.1 (or a dedicated capture run), assert every HTTP span has `softprobe.protocol` === `'http'`, `softprobe.identifier` (method + URL), and `softprobe.response.body` present with shape replay expects (e.g. statusCode and body). **Also** verify input/output: perform a request with known request and response bodies (e.g. POST to httpbin with a specific body); assert `softprobe.request.body` and `softprobe.response.body` in the trace match the actual request/response content.
  * *Test:* Automated assertion on the trace file for HTTP: required attributes and shape; content match for at least one POST with known body.

- [ ] **Task 7.3: Contract alignment – Redis (attributes, shape, and input/output content).**
  * *Action:* If the fixture uses Redis, assert Redis spans have `softprobe.protocol` === `'redis'`, `softprobe.identifier` (command + args), and `softprobe.request.body` / `softprobe.response.body` where applicable. **Also** verify input/output: run commands with known args and expected reply; assert the stored request and response body in the trace match the actual command args and reply.
  * *Test:* Automated assertion on the trace file for Redis: required attributes and shape; content match for at least one command with known args and reply.

- [ ] **Task 7.4: Contract alignment – Postgres (attributes, shape, and input/output when capture implemented).**
  * *Action:* When Postgres capture sets softprobe.* attributes, assert Postgres spans have protocol, identifier (query text), and response (and request) body shape. **Also** verify input/output: run a query with known values and expected rows; assert stored request/response in the trace match.
  * *Test:* Automated assertion on the trace file for Postgres: required attributes and shape; content match when capture is implemented.

- [ ] **Task 7.5: E2E replay (full flow).**
  * *Action:* Run the same app (or a test that loads the recorded trace) in replay mode; assert no live network and that responses come from the SemanticMatcher (recorded payloads). Optionally run the same scenario as capture and compare outcomes.
  * *Test:* Full E2E test suite passes: capture produces a valid trace file; replay uses it and returns recorded data without hitting the network.