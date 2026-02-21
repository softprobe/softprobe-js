
# Architectural Design Specification: `softprobe` v2.0

**Document Version:** 2.0 (Final)
**Author:** Principal Architect / Technical PM
**Subject:** Topology-Aware Record & Replay Testing Framework via OpenTelemetry
**Status:** Ready for Engineering Implementation

## 1. Executive Summary & Product Vision

**The Problem:** Simple request/response matching fails in complex, stateful applications (e.g., cache hits/misses, conditional branching). If a test run diverges slightly from the recorded run, standard mockers fail catastrophically.
**The Solution:** `softprobe` v2.0 captures the **entire** OpenTelemetry trace, including span lineage (parent-child relationships). During replay, it utilizes a **Semantic Tree Matching Algorithm** to map live outbound calls to the recorded trace topology, rather than relying on flat lists. It provides a robust default algorithm while allowing users to inject custom matching rules.

---

## 2. Developer Experience (The API Contract)

The golden rule remains: integration must be near-zero configuration.

### 2.1 The Global Import

The user still places this at the absolute top of their application entry point. This handles the automatic monkey-patching and hook injection.

```typescript
// /*instrumentation.ts*/
import "softprobe/init"; // MUST be the first line!

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
// ... standard otel setup ...

```

### 2.2 The Test-Time API (Replay Context & Overrides)

To solve the `traceId` matching problem, the test must explicitly tell `softprobe` *which* recorded trace it is currently attempting to replay, and optionally define custom matching rules.

```typescript
// test/user.test.ts
import { softprobe } from 'softprobe';

describe('User Service', () => {
  beforeEach(() => {
    // Tell softprobe to scope all interceptors to this specific recorded trace tree
    softprobe.setReplayContext({ traceId: 'a1b2c3d4e5f6g7h8' });
  });

  afterEach(() => {
    softprobe.clearReplayContext();
    softprobe.clearCustomMatchers();
  });

  it('should fetch user and handle cache hits gracefully', async () => {
    // Optional: User overrides the default matching rule for a specific Redis call
    softprobe.addMatcher('redis', (liveCall, recordedSpans) => {
      // If the live app asks for a cache key, always return a cache MISS (null)
      // to force the application to test the database fallback logic.
      if (liveCall.identifier === 'get' && liveCall.requestBody.includes('user:1:cache')) {
        return { action: 'MOCK', payload: null }; 
      }
      return { action: 'CONTINUE' }; // Fall back to default tree-matching algorithm
    });

    const res = await fetch('http://localhost:3000/users/1');
    expect(res.status).toBe(200);
  });
});

```

**Replay context and isolation:** For correct isolation (especially with parallel test workers), use `softprobe.runWithContext({ traceId }, async () => { ... })` so the traceId is scoped to that async flow. `setReplayContext`/`clearReplayContext` are for single-threaded or "current continuation" usage; in Jest, `beforeEach` and the test body can run in different async contexts, so `runWithContext` is the reliable choice.

---

## 3. Data Schema: Full Trace Retention

We will no longer extract a proprietary JSON schema. We will utilize a standard `FileSpanExporter` that dumps raw OpenTelemetry `ReadableSpan` objects to disk.

```typescript
// src/types/schema.ts
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';

// We extend the standard OTel Span attributes with our payloads
export interface SoftprobeAttributes {
  'softprobe.protocol': 'http' | 'postgres' | 'redis' | 'amqp';
  'softprobe.identifier': string;
  'softprobe.request.body'?: string;
  'softprobe.response.body'?: string;
}

// The storage format is a map of traceId -> array of spans
export type SoftprobeTraceStore = Record<string, ReadableSpan[]>;

```

**Implementation reminder:** When loading traces from disk, the exporter writes serialized (plain) span objects. Any loader that populates an in-memory `SoftprobeTraceStore` must deserialize so that each value satisfies `ReadableSpan` (e.g. has `spanContext()`, `parentSpanId`, `name`, `attributes`) for the matcher and replay code to work correctly.

### 3.1 Capture–Replay Protocol Pairs

Capture and replay are **always implemented in pairs** per protocol. For each supported protocol we define both how we capture (which OpenTelemetry instrumentation/hook and which attributes we set) and how we replay (which driver we patch and how we call the matcher). The same `softprobe.protocol` value, identifier semantics, and request/response payload shape are used in both directions so that any recorded span can be matched and replayed.

| Protocol  | Capture (instrumentation / hook) | Replay (patch target) | Identifier | Request/response shape |
|-----------|-----------------------------------|------------------------|------------|-------------------------|
| **http**  | `@opentelemetry/instrumentation-http` (or undici) responseHook | undici `Dispatcher` / `MockAgent` | Method + URL (e.g. `GET https://api.example.com/users`) | request: optional body; response: status + body |
| **postgres** | `@opentelemetry/instrumentation-pg` responseHook | `pg.Client.prototype.query` (shimmer) | SQL text | request: query text + values; response: `{ rows, rowCount }` or rows array |
| **redis** | `@opentelemetry/instrumentation-redis-4` (or ioredis) responseHook | redis/ioredis command (e.g. `send_command` / `call`) | Command name + key/args (e.g. `GET user:1:cache`) | request: command + args; response: reply value |
| **amqp**  | `@opentelemetry/instrumentation-amqplib` responseHook | amqplib channel (publish/consume) | e.g. `publish exchange routingKey` or `consume queue` | request: message payload; response: ack/nack or delivery |

**Golden rule:** When adding or changing a protocol, update both capture and replay in lockstep so that identifier and payload semantics stay aligned and the matcher can always resolve a live call to a recorded span.

---

## 4. The Matching Engine: Semantic Tree Algorithm

This is the most critical component of v2.0.

**The Challenge:** During capture, a span has `traceId: A`, `spanId: 1`, `parentSpanId: 0`. During a test replay, the live application generates *new* OpenTelemetry spans (e.g., `traceId: B`, `spanId: 9`, `parentSpanId: 8`). We cannot do a strict `===` comparison on IDs.

**The Solution:** We match based on the **Semantic Lineage** of the current active span.

### 4.1 Algorithm Details

When a live outbound call (e.g., Postgres `SELECT`) is intercepted by `shimmer` during replay, the following sequence executes:

1. **Context Resolution:** Extract the *live* active span from the OpenTelemetry Context (`trace.getActiveSpan()`). Let's call this `LiveSpan`.
2. **Lineage Extraction:** Traverse up the live trace tree to build a semantic path. For example: `HTTP GET /users/:id` -> `Service.getUser` -> `Postgres.query`.
3. **Candidate Filtering:** Fetch all recorded spans belonging to the `traceId` specified in `softprobe.setReplayContext()`. Filter these to only spans matching the target protocol (e.g., `postgres`).
4. **Tree Matching (The Heuristic):**
For each candidate recorded span, compare its recorded lineage to the live lineage.
* *Rule 1 (Structural):* Does the recorded span's parent have the same semantic name/attributes as the live span's parent?
* *Rule 2 (Payload):* Does the intercepted SQL query match the candidate's `softprobe.identifier`?
* *Rule 3 (Deduplication):* If multiple exact matches exist (e.g., a loop of identical queries), select the one matching the current sequential call count for that specific lineage node. If the live call count exceeds the number of recorded matches, the engine **wraps around** and reuses the first match in the sequence (index 0).

**Custom matcher actions.** A custom matcher returns one of:

* **MOCK** — Return the given payload as the response; no tree matching, no network. Use to override what the recording would return (e.g. force a cache miss).
* **CONTINUE** — Do not override; fall through to the default tree-matching algorithm. The engine still uses the **recorded** trace to find a span and return its payload. The call remains replayed from the recording; no live network.
* **PASSTHROUGH** — Request that this call go to the **live** network (no recording). In strict replay mode this is not allowed; the engine throws *Network Passthrough not allowed in strict mode*. PASSTHROUGH would only be honored in a hypothetical non-strict mode.

### 4.2 Algorithm Implementation

```typescript
// src/replay/matcher.ts
import { trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { MatchRequest } from '../types/schema';

export class SemanticMatcher {
  private recordedSpans: ReadableSpan[];
  private customMatchers: CustomMatcherFn[] = [];
  private callSequenceMap = new Map<string, number>();

  constructor(recordedSpans: ReadableSpan[]) {
    this.recordedSpans = recordedSpans;
  }

  public findMatch(liveRequest: MatchRequest): any {
    // 1. Evaluate Custom User Overrides First
    for (const matcher of this.customMatchers) {
      const result = matcher(liveRequest, this.recordedSpans);
      if (result.action === 'MOCK') return result.payload;
      if (result.action === 'PASSTHROUGH') throw new Error('Network Passthrough not allowed in strict mode');
    }

    // 2. Default Tree-Matching Algorithm
    const liveSpan = trace.getActiveSpan();
    const liveParentName = liveSpan ? (liveSpan as any).name : 'root';

    // Filter to candidate spans of the same protocol and identifier
    const candidates = this.recordedSpans.filter(span => 
      span.attributes['softprobe.protocol'] === liveRequest.protocol &&
      span.attributes['softprobe.identifier'] === liveRequest.identifier
    );

    if (candidates.length === 0) {
      throw new Error(`[Softprobe] No recorded traces found for ${liveRequest.protocol}: ${liveRequest.identifier}`);
    }

    // 3. Lineage Scoring
    // We attempt to find the recorded span whose parent conceptually matches the live parent
    let bestMatch = candidates[0]; // Fallback to flat match if tree context is missing
    
    const lineageMatches = candidates.filter(candidate => {
      // Look up the candidate's parent in the recorded trace store
      const candidateParent = this.recordedSpans.find(s => s.spanContext().spanId === candidate.parentSpanId);
      return candidateParent && candidateParent.name === liveParentName;
    });

    if (lineageMatches.length > 0) {
      bestMatch = lineageMatches[0];
      
      // 4. Sequential resolution for loops/N+1 (wrap-around if call count exceeds matches)
      const sequenceKey = `${liveRequest.protocol}-${liveRequest.identifier}-${liveParentName}`;
      const currentCount = this.callSequenceMap.get(sequenceKey) || 0;
      bestMatch = lineageMatches[currentCount] ?? lineageMatches[0]; // wrap to first when out of range
      this.callSequenceMap.set(sequenceKey, currentCount + 1);
    }

    // Parse and return the recorded response payload attached to the matched span
    return JSON.parse(bestMatch.attributes['softprobe.response.body'] as string);
  }
}

```

---

## 5. Capture Mode Details

Capture mode remains responsible for injecting hooks into OpenTelemetry and writing the *full* spans to disk. For each protocol, capture is defined in lockstep with replay (see **§3.1 Capture–Replay Protocol Pairs**). Implementations must set `softprobe.protocol`, `softprobe.identifier`, and optional `softprobe.request.body` / `softprobe.response.body` according to that table so replay can match.

### 5.1 Standardizing the File Exporter

We will implement a `SoftprobeTraceExporter` that implements `SpanExporter`.

```typescript
// src/capture/exporter.ts
import { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import fs from 'fs';

export class SoftprobeTraceExporter implements SpanExporter {
  private filePath = './softprobe-traces.json';

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      let store = {};
      if (fs.existsSync(this.filePath)) {
        store = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      }
      for (const span of spans) {
        const traceId = span.spanContext().traceId;
        if (!store[traceId]) store[traceId] = [];
        store[traceId].push(this.serializeSpan(span));
      }
      fs.writeFileSync(this.filePath, JSON.stringify(store, null, 2));
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (err) {
      resultCallback({ code: ExportResultCode.FAILED, error: err });
    }
  }

  shutdown(): Promise<void> { return Promise.resolve(); }
  private serializeSpan(span: ReadableSpan) { /* ... maps ID, parentId, attributes, name ... */ }
}

```

**Exporter notes:** Export performs a read-modify-write of the file; it is not safe for concurrent calls from multiple processes. Implementations should only use JSON-serializable attribute values so the store round-trips correctly.

### 5.2 Hook Injection (Auto-Wiring)

When `import "softprobe/init"` is called in capture mode, it pushes our exporter into the SDK.

```typescript
// src/capture/init.ts
import shimmer from 'shimmer';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SoftprobeTraceExporter } from './exporter';

export function initCapture() {
  // 1. Hijack NodeSDK to force our exporter into the pipeline, regardless of user config
  shimmer.wrap(NodeSDK.prototype, 'start', function(originalStart) {
    return function wrappedStart() {
      // IMPORTANT: call originalStart FIRST — _tracerProvider is created inside start()
      const result = originalStart.apply(this, arguments);
      const processor = new SimpleSpanProcessor(new SoftprobeTraceExporter());
      this._tracerProvider.addSpanProcessor(processor);
      return result;
    };
  });

  // 2. Hijack auto-instrumentations to inject responseHooks per protocol (see §3.1):
  //    - Postgres: @opentelemetry/instrumentation-pg → set softprobe.* on span from query/result
  //    - HTTP/Undici: @opentelemetry/instrumentation-http or undici → set softprobe.* from request/response
  //    - Redis: @opentelemetry/instrumentation-redis-4 (or ioredis) → set softprobe.* from command/reply
  //    - AMQP: @opentelemetry/instrumentation-amqplib → set softprobe.* from publish/consume
  // ...
}

```

**NodeSDK internals — critical ordering and env-var constraints:**

1. **`_tracerProvider` lifecycle.** The `NodeSDK` creates `_tracerProvider` *inside* `start()`, not in the constructor. Any shimmer wrap of `start()` must call `originalStart()` **before** accessing `_tracerProvider`. Attempting to read it before `originalStart()` throws `TypeError: Cannot read properties of undefined`.

2. **`OTEL_TRACES_EXPORTER=none` disables recording.** When this env var is set, the SDK's `TracerProviderWithEnvExporters` produces **non-recording spans** (`span.isRecording() === false`). Non-recording spans never trigger `onEnd` on any span processor, so *no* exporter (including ours) will ever see data. Softprobe capture requires at least one active trace exporter in the SDK — the default OTLP exporter is sufficient even if no collector is running (connection errors are harmless).

3. **Provider class selection.** When the user passes no `spanProcessors` config, the SDK uses `TracerProviderWithEnvExporters` (auto-configures from env). When `spanProcessors` are provided, it uses plain `NodeTracerProvider`. Our `addSpanProcessor` after `start()` works with both, but only when spans are actually recording (see point 2).

### 5.3 Capture Hook Contracts (Contract Alignment)

Capture mode injects a `responseHook` into each protocol’s OpenTelemetry instrumentation. The **contract** is the exact shape of the second argument (`result`) that the real instrumentation passes to `responseHook(span, result)`. Our hooks must be implemented and tested against this contract so that `softprobe.*` attributes are reliably set.

**Verification requirements:**

1. **Per-protocol contract**  
   For each instrumentation package we use, the implementation must align with the package’s actual `responseHook` callback signature and `result` shape. When adding or upgrading a protocol, read the instrumentation’s types or source and update the corresponding capture module (`src/capture/<protocol>.ts`) and tests.

2. **Documented contracts**  
   In code or in this design, document the expected `result` shape per protocol (e.g. Undici: `result.request.url`, `result.request.method`, `result.response.statusCode`, `result.response.body`) so that future changes don’t silently break capture.

3. **Unit tests**  
   Unit tests must call the injected hook with a mock `result` matching the documented contract and assert that `softprobe.protocol`, `softprobe.identifier`, `softprobe.request.body`, and `softprobe.response.body` are set correctly on the span.

4. **E2E contract validation**  
   The Phase 7 E2E test must validate **contract alignment**: after running the app in capture mode, assert that the written `softprobe-traces.json` contains the expected `softprobe.*` attributes on the relevant spans (e.g. HTTP spans have identifier and response body, Redis spans have command+args and reply). This catches drift between our hooks and the real instrumentation behavior.

**Golden rule:** Capture and replay are paired per protocol; the identifier and payload semantics used in capture must match what replay expects. Any change to a capture contract must be reflected in the corresponding replay module and in the E2E assertions.

---

## 6. Replay Mode Details

Replay mode relies on the `SemanticMatcher` class defined in section 4. For each protocol, the replay interceptor is the paired counterpart of the capture hook (see **§3.1 Capture–Replay Protocol Pairs**). The driver interceptions below map directly to the matcher using the same protocol and identifier semantics as capture.

```typescript
// src/replay/postgres.ts
import shimmer from 'shimmer';
import { softprobe } from '../api'; // The test-time API state holder

export function setupPostgresReplay() {
  const pg = require('pg');
  shimmer.wrap(pg.Client.prototype, 'query', function (originalQuery) {
    return async function wrappedQuery(config: any, values: any, callback: any) {
      const queryString = typeof config === 'string' ? config : config.text;
      
      const matcher = softprobe.getActiveMatcher(); // Retrieves matcher for current traceId
      
      const mockedPayload = matcher.findMatch({
        protocol: 'postgres',
        identifier: queryString,
        requestBody: values
      });

      const mockedResult = { rows: mockedPayload, rowCount: mockedPayload.length };

      if (typeof callback === 'function') return callback(null, mockedResult);
      return Promise.resolve(mockedResult);
    };
  });
}
```
**Postgres replay note:** The snippet assumes `mockedPayload` is the recorded rows array; `rowCount` is derived from `length`. If capture stores a different shape (e.g. `{ rows, rowCount }`), replay should normalize and preserve `rowCount` from the recorded payload when available.

### 6.2 HTTP (Undici) Replay

Patch undici (e.g. via `MockAgent` or `Dispatcher` wrap). On each request, call `matcher.findMatch({ protocol: 'http', identifier: methodAndUrl, requestBody })` and return the recorded status and body. Identifier must match the format used by the HTTP capture hook (see §3.1).

### 6.3 Redis Replay

Patch the Redis client (e.g. `send_command` or ioredis `call`). On each command, call `matcher.findMatch({ protocol: 'redis', identifier: commandAndKey, requestBody: args })` and return the recorded reply. Identifier must match the format used by the Redis capture hook (see §3.1).

### 6.4 AMQP Replay

Patch the amqplib channel (publish/consume). On each publish or when delivering a consumed message, use `matcher.findMatch({ protocol: 'amqp', identifier: ... })` and return or inject the recorded payload. Identifier must match the format used by the AMQP capture hook (see §3.1).

---

## 7. Acceptance Criteria & Edge Case Validation

To certify this framework for production, the engineering team must satisfy the following complex test cases:

* **AC1: Non-Deterministic DB Fallback (The Cache Miss Scenario).** * *Setup:* Record a trace where a cache hit occurs (1 Redis call, 0 DB calls).
* *Test:* During replay, inject a custom matcher via `softprobe.addMatcher()` that forces the Redis call to return `null`. The application will logically branch to query Postgres.
* *Assert:* The system must cleanly throw an error indicating no recorded call matched (e.g. `[Softprobe] No recorded traces found for <protocol>: <identifier>`). It MUST NOT crash silently or return undefined data.


* **AC2: Semantic N+1 Query Handling.**
* *Setup:* Record a trace that runs `SELECT * FROM items WHERE user_id = $1` three consecutive times in a loop.
* *Assert:* The replay engine must correctly increment the `callSequenceMap` and return the exact row payloads in the sequence they were recorded, proving the heuristic tree matcher works.


* **AC3: Trace Isolation.** * *Assert:* When running a parallel test runner (like Jest with multiple workers), the `softprobe.setReplayContext({ traceId: '...' })` must utilize `AsyncLocalStorage` to ensure concurrent tests replaying different `traceIds` do not pollute each other's matcher instances.
* **AC4: Full Span Integrity.**
* *Assert:* The output `softprobe-traces.json` preserves topology (parent-child relationships) and all `softprobe.*` attributes on leaf spans. The serialized format is a minimal subset (traceId, spanId, parentSpanId, name, attributes); import into Jaeger or Zipkin is best-effort unless additional OTel fields (e.g. startTime, endTime, kind) are serialized.

