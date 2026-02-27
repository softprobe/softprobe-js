# Softprobe Refactor Tracker — OpenTelemetry-Style Layout Continuation

This tracker replaces completed history and contains only remaining refactor work.

Implementation rule per task:
1. write test
2. run and verify fail (red)
3. minimal implementation
4. run and verify pass (green)
5. mark `[x]` with short commit-style note
6. continue to the next first unchecked task automatically (no stop-between-tasks), unless blocked by a required human decision

> Do not implement ahead of the first unchecked task. Execute in strict order.

---

## Legend
- `[ ]` not started
- `[x]` completed (append short commit-style note)

---

## 1) Architecture Guard Expansion

- [x] **Task 1.1 Expand architecture guard for legacy folder retirement scope** — `test(arch): flag non-shim runtime files added under legacy folders`
  - **Goal**: extend guard coverage to flag non-shim production runtime usage in legacy folders (`src/bindings`, `src/capture`, `src/replay`) except approved compatibility shims.
  - **Test**: architecture guard test fails on injected non-shim runtime code in legacy folders and passes after removal.

- [x] **Task 1.2 Enforce foundation/import dependency direction for refactor targets** — `test(arch): block src/core imports from legacy runtime folders`
  - **Goal**: enforce that shared foundation modules under `src/core` do not import from instrumentation packages or legacy folders.
  - **Test**: architecture boundary test fails on injected forbidden import and passes when corrected.

---

## 2) Shared Foundation Migration

- [x] **Task 2.1 Move span binding contracts/helpers from `src/bindings` into `src/core`** — `refactor(core): relocate span helpers and keep legacy bindings as re-export shims`
  - **Goal**: migrate reusable span tagging/parsing primitives (HTTP/Redis/Postgres/test span helper) into `src/core` shared foundation location.
  - **Test**: existing span helper unit tests pass unchanged through legacy re-export shims.

- [x] **Task 2.2 Move shared identifier composition utilities into `src/core`** — `refactor(core): move identifier helpers into foundation and keep root shim exports`
  - **Goal**: place protocol-agnostic identifier helpers in foundation area and preserve behavior.
  - **Test**: existing identifier and matcher key derivation tests pass unchanged.

---

## 3) Instrumentation/Common Protocol Migration

- [x] **Task 3.1 Move protocol-specific span adaptation helpers into `src/instrumentations/common`** — `refactor(http): share inbound identifier adaptation across express and fastify packages`
  - **Goal**: migrate protocol-oriented helpers consumed by multiple instrumentations to `src/instrumentations/common/<domain>`.
  - **Test**: at least two instrumentation packages consume the migrated helper without duplicated logic.

- [x] **Task 3.2 Update instrumentation packages to consume only `src/core` + `src/instrumentations/common`** — `refactor(instrumentations): remove direct imports from legacy helper paths`
  - **Goal**: eliminate direct runtime dependency on legacy helper paths from package instrumentations.
  - **Test**: import graph/architecture guard confirms no direct package imports from legacy folders.

---

## 4) Legacy Shim Finalization

- [x] **Task 4.1 Convert remaining touched legacy runtime files to compatibility-only re-exports** — `test(arch): enforce shim-only integrity for migrated legacy files`
  - **Goal**: ensure legacy paths touched by the migration expose only compatibility markers and re-exports.
  - **Test**: shim integrity test verifies no runtime logic in these legacy files.

- [x] **Task 4.2 Verify no production imports from retired legacy targets** — `test(arch): retire bindings and stream-tap import paths from production modules`
  - **Goal**: tighten retired path checks to include refactored binding/helper modules.
  - **Test**: repo-wide retired-path guard test passes with zero violations.

---

## 5) Quality Gate

- [x] **Task 5.1 Full refactor validation** — `test(refactor): pass targeted guard suite and full repo tests (stable with --maxWorkers=50%)`
  - **Goal**: run targeted unit suite for migrated modules, architecture guards, and then full repository tests.
  - **Test**: all refactor-related tests and full test suite pass with zero failures.
