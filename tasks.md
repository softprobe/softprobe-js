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
