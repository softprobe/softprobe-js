# SoftprobeContext Design

This document defines the current `SoftprobeContext` runtime contract.

Related docs:
- [Main design](./design.md)
- [Cassette design](./design-cassette.md)
- [Matcher design](./design-matcher.md)

---

## 1) Goals

- Keep Softprobe state scoped to OpenTelemetry context.
- Keep context immutable (`withData` returns a new context).
- Centralize request/test run setup in `SoftprobeContext.run(options, fn)`.
- Keep cassette creation in one place (`SoftprobeContext`), not in middleware/wrappers.

---

## 2) Stored State

`SoftprobeContext` stores this per-scope state:
- `mode`: `CAPTURE | REPLAY | PASSTHROUGH`
- `traceId`
- `storage` (`Cassette`) when available
- `cassetteDirectory` (used to derive per-trace file paths)
- strict flags (`strictReplay`, `strictComparison`)
- `matcher` (replay)
- `inboundRecord` (for response comparison)

Global defaults are seeded once at boot by `softprobe/init`.

---

## 3) Public API

### 3.1 Getters

- `active(otelContext?)`
- `getTraceId(otelContext?)`
- `getMode(otelContext?)`
- `getCassette(otelContext?)`
- `getCassetteDirectory(otelContext?)`
- `getScopedCassette(otelContext?)`
- `getStrictReplay(otelContext?)`
- `getStrictComparison(otelContext?)`
- `getMatcher(otelContext?)`
- `getInboundRecord(otelContext?)`

### 3.2 Writers / Scope entry

- `withData(otelContext, partialData)`
- `fromHeaders(base, headers)`
- `initGlobal(config)`
- `run(options, fn)`

### 3.3 Cassette creation utility

- `getOrCreateCassette(cassetteDirectory, traceId)`

This is the only place where `NdjsonCassette` instances are created.

---

## 4) Header Coordination

`fromHeaders` currently accepts:
- `x-softprobe-mode`
- `x-softprobe-trace-id`

When present and valid, these override the current request scope.

---

## 5) Run Flow

## 5.1 REPLAY

1. Merge active context defaults with `SoftprobeRunOptions`.
2. Resolve `traceId`.
3. Resolve cassette from `options.storage` or `{cassetteDirectory}/{traceId}.ndjson`.
4. Load records once via `storage.loadTrace()`.
5. Seed a fresh `SoftprobeMatcher` with records.
6. Execute callback in `context.with(newCtx, fn)`.

## 5.2 CAPTURE / PASSTHROUGH

1. Merge defaults and options.
2. Ensure `traceId`.
3. Resolve cassette (`storage` or derived from `cassetteDirectory + traceId` when available).
4. Execute callback in scoped OTel context.

---

## 6) Error Handling

- REPLAY requires resolvable storage (`storage` or `cassetteDirectory + traceId`).
- Missing replay storage throws immediately.

---

## 7) OTel Context Key

`SOFTPROBE_CONTEXT_KEY` is the single key used for Softprobe state in OTel context.
