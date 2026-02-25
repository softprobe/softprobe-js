# SoftprobeContext Design: Single Immutable Context API

This document describes the **SoftprobeContext** abstraction: one module, one API surface, and immutable OTel context handling. It replaces the current split between `ReplayContext`, `SoftprobeContextValue`, `getSoftprobeContext` / `setSoftprobeContext`, and ad-hoc object construction in `api.ts`.

---

## 1. Goals

- **Single abstraction**: One place for all context read/write and run-scoping. No separate “replay context” vs “softprobe context value” types.
- **Immutable**: Context is never mutated. “Set” operations return a new OTel context (e.g. `withData(ctx, data)` returns a new context).
- **Simple API**: Callers read via `SoftprobeContext.getXXX()` and write via `run(partial, fn)` or `withData(otelContext, data)`. No public “data” type; the stored shape is an implementation detail.
- **Backward compatibility**: Existing `context.ts` and `api.ts` can re-export or delegate to SoftprobeContext so current call sites keep working during migration.

---

## 2. Why a Single Context Object?

Today we have:

- **ReplayContext** (input to `runWithContext`) and **SoftprobeContextValue** (stored in OTel) with nearly identical fields, kept in sync by hand.
- **toSoftprobeContextValue()** and then manual `{ ...otelValue, matcher, inboundRecord }` when loading a cassette.
- Context read from **context.ts** (`getSoftprobeContext`, `setSoftprobeContext`) and from **api.ts** (`getReplayContext`, `getActiveMatcher`, `getRecordedInboundResponse`).

A single **SoftprobeContext** object with a clear, minimal API removes duplication and one-off object building. All context state lives in one stored value; callers interact only through methods.

---

## 3. Immutability

- **OpenTelemetry Context is immutable.** `ctx.setValue(key, value)` returns a *new* context; it does not mutate `ctx`.
- SoftprobeContext follows the same rule:
  - **withData(otelContext, data)** returns a *new* OTel context that carries the given softprobe data. The name “withData” (not “setOnContext”) makes it clear that the original context is unchanged.
  - No in-place mutation of the active context. To “set” context for a scope, you run code inside `context.with(newCtx, fn)` where `newCtx = SoftprobeContext.withData(activeCtx, data)`.

---

## 4. Public API

All methods live on a single object: **SoftprobeContext**.

### 4.1 Reading (getters)

Callers read current state only through getters. There is no public “context data” type to hold or pass around for reading.

| Method | Returns | Notes |
|--------|---------|--------|
| `active(otelContext?)` | Current softprobe state (internal shape; type not exported) | Defaults to `context.active()`. Returns global default when no value in OTel context. |
| `getTraceId(otelContext?)` | `string \| undefined` | |
| `getMode(otelContext?)` | `'CAPTURE' \| 'REPLAY' \| 'PASSTHROUGH'` | |
| `getCassettePath(otelContext?)` | `string` | |
| `getStrictReplay(otelContext?)` | `boolean` | |
| `getStrictComparison(otelContext?)` | `boolean` | |
| `getMatcher(otelContext?)` | `SemanticMatcher \| SoftprobeMatcher \| undefined` | Includes fallback to global replay matcher and baggage when mode is REPLAY. |
| `getInboundRecord(otelContext?)` | `SoftprobeCassetteRecord \| undefined` | |

Optional `otelContext` allows passing an explicit OTel context (e.g. in tests); when omitted, the active OTel context is used.

### 4.2 Writing (immutable)

| Method | Purpose |
|--------|--------|
| `withData(otelContext, data)` | Returns a **new** OTel context with the given softprobe data. Does not mutate `otelContext`. Used by middleware and by `run()` internally. |
| `initGlobal(config)` | Seeds the global default (mode, cassettePath, strictReplay, strictComparison) from YAML/config. Call at boot. |
| `fromHeaders(base, headers)` | Returns a new softprobe state by applying coordination headers over `base`. Used by middleware. |
| `setGlobalReplayMatcher(matcher)` | Sets the global matcher used when active context has no matcher (e.g. server REPLAY mode). |

The type of `data` in `withData(ctx, data)` is internal: a private interface or inline type. Callers (e.g. middleware) pass a plain object; they do not need a named exported type.

### 4.3 Scoped run

| Method | Purpose |
|--------|--------|
| `run(partial, fn)` | Runs `fn` in an OTel context whose softprobe state is the merge of current active/global default and `partial`. If `partial.cassettePath` is set, loads NDJSON, builds matcher and inbound record, merges into one value, then runs `fn` inside `context.with(SoftprobeContext.withData(otelCtx, merged), fn)`. Single place for “build full value” and cassette load; no ad-hoc spread at call sites. |

The type of `partial` is an internal “partial context” type (e.g. all fields optional). Not exported; callers pass e.g. `{ traceId: 'x', matcher }` and get type-checking via the parameter type.

---

## 5. Internal Storage Shape (private)

- A single **private** type describes the value stored under the OTel context key. It holds: `mode`, `cassettePath`, `traceId`, `strictReplay`, `strictComparison`, `matcher`, `inboundRecord`.
- This type is used only:
  - As the value in `ctx.setValue(SOFTPROBE_CONTEXT_KEY, value)`.
  - As the return type of `active()` (concrete but not exported as a named type).
  - As the parameter type for `withData(ctx, data)` and the `partial` parameter of `run(partial, fn)` (inline or private interface).

No `SoftprobeContext.Data` or `SoftprobeContextValue` is exported. Callers that need “the same shape as active()” can use `ReturnType<typeof SoftprobeContext.active>` if needed.

---

## 6. OTel Context Key

- **SOFTPROBE_CONTEXT_KEY**: The single key under which the softprobe value is stored in OTel Context. Exported for tests that assert on `context.active().getValue(SOFTPROBE_CONTEXT_KEY)`.

---

## 7. Backward Compatibility and Migration

- **context.ts** can become a thin re-export layer:
  - `getSoftprobeContext(ctx?)` → `SoftprobeContext.active(ctx)`.
  - `setSoftprobeContext(ctx, value)` → `SoftprobeContext.withData(ctx, value)`.
  - `initGlobalContext(config)` → `SoftprobeContext.initGlobal(config)`.
  - `softprobeValueFromHeaders(base, headers)` → `SoftprobeContext.fromHeaders(base, headers)`.
  - `SOFTPROBE_CONTEXT_KEY` re-exported from the new module.
  - Legacy type alias `SoftprobeContextValue` can point at the internal stored type or at `ReturnType<typeof SoftprobeContext.active>`.

- **api.ts** becomes a thin facade:
  - `runWithContext(partial, fn)` → `SoftprobeContext.run(partial, fn)`.
  - `getReplayContext()` → `SoftprobeContext.active()`.
  - `getActiveMatcher()` → `SoftprobeContext.getMatcher()`.
  - `getRecordedInboundResponse()` → `SoftprobeContext.getInboundRecord()`.
  - `setGlobalReplayMatcher(m)` → `SoftprobeContext.setGlobalReplayMatcher(m)`.
  - Public `softprobe` object and other APIs (e.g. `compareInbound`, `getRecordsForTrace`, `activateReplayForContext`, `flushCapture`, `getContextWithReplayBaggage`) unchanged in behavior; they call through SoftprobeContext where appropriate.

Existing middleware and tests that import from `context` or `api` continue to work; implementation is centralized in the new SoftprobeContext module.

---

## 8. Summary

| Concept | Before | After |
|--------|--------|--------|
| Types | ReplayContext, SoftprobeContextValue, manual object spread | Single private stored shape; no exported “data” type |
| Read | getSoftprobeContext(), getReplayContext(), getActiveMatcher(), getRecordedInboundResponse() | SoftprobeContext.getXXX() and active() |
| Write | setSoftprobeContext(ctx, value), toSoftprobeContextValue(), ad-hoc merge in runWithContext | SoftprobeContext.withData(), run(partial, fn), initGlobal(), fromHeaders() |
| Immutability | setSoftprobeContext returns new ctx but name suggests mutation | withData(ctx, data) returns new context; naming reflects immutability |

One module, one API, one internal shape, immutable context handling.
