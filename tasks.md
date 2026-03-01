# Softprobe Delivery Tracker — CLI Capture + Cursor Skills

Implementation rule per task:
1. implement the smallest change for the active task
2. validate only with Softprobe CLI flows (`capture` / `diff`) as the testing method
3. skip TDD and do not add or require red/green unit-test cycles for task completion
4. mark `[x]` with short commit-style note
5. continue to the next first unchecked task automatically (no stop-between-tasks), unless blocked by a required human decision

> Do not implement ahead of the first unchecked task. Execute in strict order.

---

## Legend
- `[ ]` not started
- `[x]` completed (append short commit-style note)

---

## Mounted Router Path Capture Bug (`capture-replay-001`)

- [x] Add regression test proving mounted Express router requests (e.g. `/products`) are not captured as `GET /`. - `test(express): add mounted-router originalUrl regression for inbound identifier`
- [x] Fix Express inbound capture path selection to persist mounted route paths. - `fix(express): resolve inbound capture path from originalUrl/url before req.path`
- [x] Verify fix with focused test run for Express capture middleware. - `test(express): pass capture-express regression and existing middleware coverage`

## DRY Inbound Path Resolution (Express + Fastify)

- [x] Add Fastify capture regression test to assert inbound identifier path excludes query and remains canonical. - `test(fastify): add inbound identifier regression for queryless canonical path`
- [x] Introduce shared inbound path resolver in `instrumentations/common/http` and use it from Express and Fastify capture paths. - `refactor(http): extract shared resolveInboundPath helper for framework capture adapters`
- [x] Verify Express + Fastify capture tests pass with shared resolver. - `test(http): pass capture-express and capture-fastify suites with shared resolver`

## Inbound Path Robustness Coverage

- [x] Add exhaustive resolver tests for mounted routers, query strings, absolute URLs, fallback precedence, and empty inputs. - `test(http): add resolveInboundPath matrix coverage for edge-case URL shapes`
- [x] Update shared resolver and framework expectations to preserve query parameters while keeping canonical replay-safe paths. - `fix(http): normalize inbound URLs with query preservation and fragment stripping`
- [x] Verify resolver + Express + Fastify capture suites pass with the expanded matrix. - `test(http): pass inbound-path, capture-express, and capture-fastify suites`

## Express 4 Injection + Async Response Capture (`express-compat-001`)

- [x] Add regression test proving Express 4 style `app.get()` route registration (`_router.route`) still injects Softprobe middleware. - `test(express): add express4 app.get->_router.route mutator regression`
- [x] Fix Express mutator injection so middleware is guaranteed for Express 4 and Express 5 route registration flows. - `fix(express): inject middleware from verb and route registration hooks with idempotent guard`
- [x] Add regression test proving inbound capture still writes when `res.send()` executes after an async boundary. - `test(express): add async-boundary inbound capture regression with cassetteDirectory-only config`
- [x] Fix inbound response capture to use request-scoped snapshot data instead of `context.active()` lookup at send-time. - `fix(http): pass request-scoped capture snapshot into inbound response writer`
- [x] Verify focused Express mutator/capture test suites pass. - `test(express): pass framework-mutator and capture-express focused suites`

## Wrapper Metadata Conflict Hardening (`wrapper-runtime-001`)

- [x] Add regression tests proving Softprobe wrappers avoid `__wrapped` and expose Softprobe-owned wrapper metadata (marker + original name). - `test(runtime): add no-conflict wrapper metadata regression coverage`
- [x] Add shared no-conflict wrapper utility in foundation runtime and document marker semantics. - `feat(runtime): add wrapMethodNoConflict with softprobe marker and original-name metadata`
- [x] Migrate all current `shimmer.wrap` usage and ad-hoc wrapper markers to the shared wrapper utility. - `refactor(wrapping): replace mutator/framework/postgres/redis wrapping with runtime no-conflict utility`
- [x] Verify focused wrapper/mutator/replay test suites pass after migration. - `test(wrapping): pass wrap-runtime mutator framework-mutator replay-postgres replay-redis import-order-guard suites`
