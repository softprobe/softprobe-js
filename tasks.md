# Softprobe Refactor Tracker — OpenTelemetry-Style Layout Continuation

This tracker replaces completed history and contains only remaining refactor work.

Implementation rule per task:
1. implement the smallest change for the active task
2. validate only with Softprobe flows (capture/replay/diff) as the testing method
3. skip TDD and do not add or require red/green unit-test cycles for task completion
4. mark `[x]` with short commit-style note
5. continue to the next first unchecked task automatically (no stop-between-tasks), unless blocked by a required human decision

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

## 6) Demo App Expansion

- [x] **Task 6.1 Add manual pricing-regression demo with v1/v2 app flow** — `feat(example): add manual pricing regression demo with v1/v2 and replay diff mismatch`
  - **Goal**: provide a customer-facing manual demo with two nearly identical app versions where v2 introduces a pricing bug (wrong price, no exception), captured with curl and verified via replay diff mismatch output.
  - **Verification**: run Softprobe capture with v1, replay/diff against v2, and confirm mismatch output shows `priceCents` recorded `1080` vs live `1180`.

## 7) Release Readiness

- [x] **Task 7.1 Prepare npm + GitHub Actions release pipeline and developer quick start** — `chore(release): add npm publish workflow and scoped-package quick start docs`
  - **Goal**: publish the package as `@softprobe/softprobe-js`, add an automated GitHub Actions release workflow for npm, and update README with a practical quick start for library + CLI usage.
  - **Verification**: release workflow file exists, package metadata targets scoped npm package, and README documents install/release/quick-start commands.

- [x] **Task 7.2 Make global CLI install the primary developer experience** — `docs(cli): make global softprobe command the default UX`
  - **Goal**: document and expose Softprobe as a globally installed CLI (`softprobe`) similar to aws/claude style tooling, with scoped-package `npx` as fallback.
  - **Verification**: README and package metadata clearly present global installation and `softprobe` command-first usage.

- [x] **Task 7.3 Improve CLI ergonomics for global-tool usage** — `feat(cli): add --help and --version for global command discoverability`
  - **Goal**: provide standard CLI affordances (`--help`, `--version`) so global `softprobe` usage is self-discoverable.
  - **Verification**: `softprobe --help` and `softprobe --version` are documented and implemented in CLI entrypoint.

- [x] **Task 7.4 Migrate release pipeline from npm token auth to Trusted Publishing** — `chore(release): remove NPM_TOKEN usage and document OIDC trusted publishing`
  - **Goal**: align publish flow with npm token changes by using GitHub OIDC trusted publishing instead of token-based auth.
  - **Verification**: release workflow has no `NODE_AUTH_TOKEN` usage and README release setup states trusted publishing.
