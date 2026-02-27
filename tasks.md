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
6. continue to the next first unchecked task automatically (no stop-between-tasks), unless blocked by a required human decision

> Do not implement ahead of the first unchecked task. Always execute tasks in order and auto-advance after each completed task.

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

## 2) OpenTelemetry-Style Package Layout Refactor — Atomic

Goal for this section:
- Migrate runtime code to package-oriented structure before adding new library support.
- Keep current feature behavior unchanged.
- Scope to currently supported integrations only: `express`, `fastify`, `redis`, `postgres`, `fetch` (undici).

Required dependency direction for all tasks in this section:
- Allowed: `core -> (no instrumentation deps)`, `instrumentations/<pkg> -> core + instrumentations/common`
- Disallowed: `core -> instrumentations/*`, `instrumentations/<pkg-a> -> instrumentations/<pkg-b>`

- [x] **Task 2.1 Create foundation package structure under `src/core` (no behavior changes)** — `feat(core): add foundation package entry points and architecture guard test`
  - **Deliverable**: establish folders for shared APIs/contracts/utilities used by all instrumentations.
  - **Test**: import smoke/type test verifies core modules compile and are importable without referencing any instrumentation package.

- [x] **Task 2.2 Create instrumentation package folders for supported libraries** — `feat(instrumentations): add package entry points for express fastify redis postgres fetch`
  - **Deliverable**: create `src/instrumentations/express`, `src/instrumentations/fastify`, `src/instrumentations/redis`, `src/instrumentations/postgres`, `src/instrumentations/fetch`.
  - **Test**: compile-time path smoke test confirms each package exposes an entry module.

- [x] **Task 2.3 Create shared protocol helper areas under `src/instrumentations/common`** — `feat(common): add shared http header helper consumed by express and fastify packages`
  - **Deliverable**: add common helper folders for shared protocol logic (e.g. http/shared tagging/parsing helpers) used by multiple packages.
  - **Test**: unit tests prove helpers are consumed by at least two package folders with no duplicated logic blocks.

- [x] **Task 2.4 Move Express instrumentation into `src/instrumentations/express`** — `refactor(express): migrate capture and replay runtime into package folder with legacy re-export shims`
  - **Deliverable**: migrate Express middleware/patch integration files from legacy locations into package folder with unchanged behavior.
  - **Test**: existing Express capture/replay unit/e2e tests pass without modifications to expected outputs.

- [x] **Task 2.5 Move Fastify instrumentation into `src/instrumentations/fastify`** — `refactor(fastify): migrate plugin and replay hook into package folder with legacy re-export shims`
  - **Deliverable**: migrate Fastify hook/plugin integration files into package folder with unchanged behavior.
  - **Test**: existing Fastify capture/replay unit/e2e tests pass unchanged.

- [x] **Task 2.6 Move Redis instrumentation into `src/instrumentations/redis`** — `refactor(redis): migrate capture and replay runtime into package folder with legacy re-export shims`
  - **Deliverable**: migrate Redis replay/capture integration files into package folder with unchanged behavior.
  - **Test**: existing Redis unit/e2e replay and capture tests pass unchanged.

- [x] **Task 2.7 Move Postgres instrumentation into `src/instrumentations/postgres`** — `refactor(postgres): migrate capture and replay runtime into package folder with legacy re-export shims`
  - **Deliverable**: migrate Postgres replay/capture integration files into package folder with unchanged behavior.
  - **Test**: existing Postgres unit/e2e replay and capture tests pass unchanged.

- [x] **Task 2.8 Move Fetch/HTTP outbound instrumentation into `src/instrumentations/fetch`** — `refactor(fetch): migrate http replay interceptor runtime into package folder with legacy re-export shim`
  - **Deliverable**: migrate undici/fetch replay interceptor and outbound capture integration into package folder with unchanged behavior.
  - **Test**: existing HTTP replay/capture tests (including strict negative cases) pass unchanged.

- [x] **Task 2.9 Update init/boot wiring to consume new package entry points** — `refactor(init): switch boot replay setup imports to instrumentation package entry points`
  - **Deliverable**: `softprobe/init` imports from package folders only; behavior remains “init first, patch before OTel”.
  - **Test**: boot/import-order guard tests remain green and still enforce pre-OTel patch ordering.

- [x] **Task 2.10 Add architecture guard tests for dependency direction and forbidden imports** — `test(architecture): add guard utility and tests for core/instrumentation import boundaries and legacy shim constraints`
  - **Deliverable**: automated checks preventing:
    - `src/core` importing `src/instrumentations/*`
    - one instrumentation package importing another package directly
    - new files added to legacy mixed folders when equivalent package folder exists
  - **Test**: guard test fails on intentionally injected forbidden import and passes when removed.

- [x] **Task 2.11 Remove or deprecate legacy mixed folders after migration** — `test(architecture): enforce no production imports from retired legacy capture/replay modules`
  - **Deliverable**: eliminate duplicate runtime paths and keep single source of truth in new structure.
  - **Test**: repo-wide grep/import graph confirms no production imports from retired legacy paths.

- [x] **Task 2.12 Documentation sync for layout and contribution rules** — `docs(readme): document package-oriented layout for core, instrumentations, and common helpers`
  - **Deliverable**: update docs to reflect new folder structure and extension workflow for future library support.
  - **Test**: docs consistency tests pass and include references to `src/core`, `src/instrumentations/<package>`, and `src/instrumentations/common`.

- [x] **Task 2.13 Validate full quality gate: all tests and examples pass** — `test(quality-gate): run full jest suite and example capture/replay validation successfully`
  - **Deliverable**: run the full automated test suite and examples validation after migration tasks are complete.
  - **Test**: repository test and example commands complete successfully with zero failures.
