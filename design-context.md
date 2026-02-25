# SoftprobeContext Design: Single Immutable Context API

This document describes the **SoftprobeContext** abstraction: one module, one API surface, and immutable OTel context handling. 

Related docs:
- [Main design](./design.md)
- [Cassette design](./design-cassette.md)
- [Matcher design](./design-matcher.md)

---

## 1. Goals

- **Single abstraction**: One place for all context read/write and run-scoping.
- **Immutable**: Context is never mutated. “Set” operations return a new OTel context (e.g. `withData(ctx, data)` returns a new context).
- **Simple API**: Callers read via `SoftprobeContext.getXXX()` and write via `run(options, fn)` or `withData(otelContext, data)`. No public “data” type; the stored shape is an implementation detail.
- **Backward compatibility**: NOT SUPPORTED. KEEP THINGS SIMPLE.

---

## 2. Immutability

- **OpenTelemetry Context is immutable.** `ctx.setValue(key, value)` returns a *new* context; it does not mutate `ctx`.
- SoftprobeContext follows the same rule:
  - **withData(otelContext, data)** returns a *new* OTel context that carries the given softprobe data. The name “withData” (not “setOnContext”) makes it clear that the original context is unchanged.
  - No in-place mutation of the active context. To “set” context for a scope, you run code inside `context.with(newCtx, fn)` where `newCtx = SoftprobeContext.withData(activeCtx, data)`.

---

## 3. Public API

All methods live on a single object: **SoftprobeContext**.

### 3.1 Reading (getters)

Callers read current state only through getters. There is no public “context data” type to hold or pass around for reading.

| Method | Returns | Notes |
|--------|---------|--------|
| `active(otelContext?)` | Current softprobe state (internal shape; type not exported) | Defaults to `context.active()`. Returns global default when no value in OTel context. |
| `getTraceId(otelContext?)` | `string` | |
| `getMode(otelContext?)` | `'CAPTURE' \| 'REPLAY' \| 'PASSTHROUGH'` | |
| `getCassette(otelContext?)` | `Cassette` | |
| `getStrictReplay(otelContext?)` | `boolean` | |
| `getStrictComparison(otelContext?)` | `boolean` | |
| `getMatcher(otelContext?)` | `SemanticMatcher \| SoftprobeMatcher \| undefined` | Includes fallback to global replay matcher and baggage when mode is REPLAY. |

Optional `otelContext` allows passing an explicit OTel context (e.g. in tests); when omitted, the active OTel context is used.

### 3.2 Writing (Scoped Execution)

Context is immutable, mutation of context is imeplemented via `SoftprobeContext.run`.

The run method is the unified way to start a Softprobe-instrumented block. It handles the "Reader" (Replay) and "Writer" (Capture) initialization.

```TypeScript
export type SoftprobeMode = 'CAPTURE' | 'REPLAY' | 'PASSTHROUGH';

export interface Cassette {
  /**
   * REPLAY: Pulls records associated with this specific trace.
   */
  loadTrace(traceId: string): Promise<SoftprobeCassetteRecord[]>;

  /**
   * CAPTURE: Pushes a record for the active trace.
   * Implementation handles background buffering/flushing.
   */
  saveRecord(traceId: string, record: SoftprobeCassetteRecord): Promise<void>;

  /**
   * Optional: Ensures all pending captures are persisted (e.g., on process exit).
   */
  flush?(): Promise<void>;
}

interface SoftprobeRunOptions {
  mode: SoftprobeMode;
  storage: Cassette; 
  traceId: string; // The primary key for the execution
  matcher?: MatcherFn; // Optional logic override
}

/**
 * Returns a new OTel context with the given softprobe data. Does not mutate otelContext.
 */
function withData(otelContext: Context, data: PartialData): Context {
  const stored = merge(globalDefault, data);
  return otelContext.setValue(SOFTPROBE_CONTEXT_KEY, stored);
}

//  Runs `fn` in an OTel context whose softprobe state is the merge of current Softprobe context data. 
static async run<T>(options: SoftprobeRunOptions, fn: () => Promise<T>): Promise<T> {
  const activeCtx = context.active();

  // Use OTel to install the new immutable context
  const newOtelCtx = SoftprobeContext.withData(activeCtx, options);
  return context.with(newOtelCtx, fn);
}
```

## 4. Context Creation

### 4.1 Workflow
The basic workflow for both capture and replay mode
* Initialize Softprobe
* Initialize Otel `NodeSDK`
* Start Otel `Span`
* Create `SoftprobeContext`
  * Create an instance of `SoftprobeRunOptions`, includes
    * `mode`: required
    * `cassette`: required, for write in capture mode, and for read in replay mode
    * `matcher` (only required on replay mode)
  * Create an instance of `SoftprobeContext` with `SoftprobeContext.withData(options, ...)`
* Run a function within the `SoftprobeContext`.

`matcher` will need to access `cassette` to get the current records so that it can find matches to mock an API call.

### 4.2 Entry point
`SoftprobeContext` is created by the following ways:
1. HTTP API entry point (express/fastify/Server): middleware that create an instance of `options: SoftprobeRunOptions` and call `SoftprobeContext.run(options, next)`.
2. Future extension to other application entry points.

---

## 5. OTel Context Key

- **SOFTPROBE_CONTEXT_KEY**: The single key under which the softprobe value is stored in OTel Context. Exported for tests that assert on `context.active().getValue(SOFTPROBE_CONTEXT_KEY)`.
