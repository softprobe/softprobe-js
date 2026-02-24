# Softprobe Record & Replay — Consolidated Design (v4.1)

This document merges **v2/v3/v3.5** into **v4** to form a complete design.
- **v4 is the source of truth** for overall architecture and conflicting decisions (typed bindings, matcher list, wrapper behavior, NDJSON cassette baseline).
- **v2/v3/v3.5 details are reintroduced** where they add missing critical capabilities (production-safe capture side-channel + write queue, config + ignore/bypass, import-order guard, AsyncLocalStorage isolation, inbound capture + “compare response”, Jest/E2E constraints, topology-aware matching as an optional matcher).

---

## 1) Background

### Why record & replay (and why simple mocks fail)
Simple mocks (“request → response”) break when runtime diverges from the recorded run (cache hit vs miss, conditional branches, loops, retries). v2 introduced trace/topology-aware matching to survive these divergences.

### Why v3.5 changed capture architecture
Writing full payloads into OpenTelemetry span attributes caused span bloat and event-loop pressure. v3.5 moved payload capture to a production-safe **NDJSON side channel** written by a single-threaded queue.

### What v4 fixed
v4 simplified integration and matching:
- Wrappers are minimal (shimmer/MSW).
- Matchers are a list of functions (first non-`CONTINUE` wins).
- Matchers do **not** execute passthrough.
- Typed bindings hide attribute keys and avoid stringly-typed user code.

v4.1 = **v4 simplicity** + **v3.5 production capture correctness** + **v2/v3 topology matching as an optional matcher**.

---

## 2) Goals and non-goals

### Goals
- **Near-zero config integration**: `import "softprobe/init"` as the first line.
- **Production-safe capture**: do not put big payloads in span attrs; write NDJSON via a single-threaded queue.
- **Deterministic replay** in CI (strict mode) + optional passthrough locally.
- **Matching extensibility**: keep v4 matcher model; add topology-aware matcher as just another matcher fn.
- **Parallel tests**: AsyncLocalStorage-based isolation for replay context (traceId + loaded records).
- **HTTP coverage**: support `fetch` and legacy clients via `@mswjs/interceptors`.

### Non-goals
- A heavy “framework” abstraction beyond wrappers + matchers + typed bindings.
- Default-on topology scoring; topology matcher is optional.

---

## 3) High-level architecture (v4.1)

Softprobe has three core concerns (v4):
1) **Capture**
2) **Replay**
3) **Matching**

v3.5 adds: a production-safe capture pipeline + config + bypass/ignore.

### 3.1 Replay runtime flow
1. A library call happens (pg/redis/http).
2. OTel instrumentation creates an active span.
3. A Softprobe wrapper tags the span via **typed binding**.
4. Wrapper calls `matcher.match()` (no args).
5. Wrapper executes:
   - `MOCK`: return mocked result
   - `PASSTHROUGH`: call original
   - `CONTINUE`: wrapper policy (passthrough in dev, throw / hard-fail in strict CI)

### 3.2 Capture flow (production-safe)
- OTel hooks tap request/response streams and driver results.
- Payloads are written to NDJSON via a **single-threaded write queue**.
- Spans only get small identifiers/metadata (or nothing beyond what OTel already sets).

---

## 4) Developer experience and public API

### 4.1 Global import (must be line 1)
```ts
// instrumentation.ts
import "softprobe/init"; // MUST be the first line

import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
```

**Why:** driver shims must run before OTel wraps modules. If OTel wraps first, wrappers can become “nesting dolls” and break matching.

### 4.2 Test-time API (AsyncLocalStorage-safe)
```ts
import { softprobe } from "softprobe";

it("replays a recorded production transaction", async () => {
  await softprobe.runWithContext(
    { traceId: "prod-trace-345", cassettePath: "./softprobe-cassettes.ndjson" },
    async () => {
      // Optional matcher override (inserted ahead of defaults)
      softprobe.getActiveMatcher().use((span, records) => {
        const r = RedisSpan.fromSpan(span);
        if (r && r.identifier.includes("GET user:1:cache")) {
          return { action: "MOCK", payload: null };
        }
        return { action: "CONTINUE" };
      });

      const res = await fetch("http://localhost:3000/users/1");
      expect(res.status).toBe(200);

      // Optional: compare to recorded inbound response for this trace
      const inbound = softprobe.getRecordedInboundResponse();
      expect(await res.json()).toEqual(inbound?.responsePayload?.body);
    }
  );
});
```

---

## 5) Configuration (.softprobe/config.yml)

Because `softprobe/init` must be imported first, configuration must be discoverable synchronously at boot.

**File:** `./.softprobe/config.yml`
```yaml
capture:
  maxPayloadSize: 1048576         # 1MB circuit breaker
  outputFile: "./softprobe-cassettes.ndjson"

replay:
  ignoreUrls:
    - "localhost:431[78]"
    - "/v1/traces"
    - "datadog-agent:8126"
    - "api\.stripe\.com"        # optional “intentional live”
```

Centralized bypass check (used by capture + replay interceptors):
```ts
import fs from "fs";
import { parse } from "yaml";

class ConfigManager {
  private ignoreRegexes: RegExp[] = [];
  private cfg: any;

  constructor() {
    this.cfg = parse(fs.readFileSync("./.softprobe/config.yml", "utf8"));
    this.ignoreRegexes = (this.cfg.replay?.ignoreUrls || []).map((p: string) => new RegExp(p));
  }

  shouldIgnore(url?: string) {
    if (!url) return false;
    return this.ignoreRegexes.some((re) => re.test(url));
  }

  get() { return this.cfg; }
}

export const softprobeConfig = new ConfigManager();
```

---

## 6) Cassette format (NDJSON)

v4 baseline is retained; v3.5 adds critical topology and direction fields.

### 6.1 Schema
```ts
export type Protocol = "http" | "postgres" | "redis" | "amqp" | "grpc";
export type RecordType = "inbound" | "outbound" | "metadata";

export type SoftprobeCassetteRecord = {
  version: "4.1";
  traceId: string;

  // identity + topology (enables optional topology matcher)
  spanId: string;
  parentSpanId?: string;
  spanName?: string;
  timestamp: string; // ISO

  // direction
  type: RecordType;

  // matching keys
  protocol: Protocol;
  identifier: string; // “golden key” per protocol (must match capture+replay)

  // payloads (side-channel only)
  requestPayload?: any;
  responsePayload?: any;

  // optional helper fields
  statusCode?: number;
  error?: { message: string; stack?: string };
};
```

### 6.2 Golden key rule
`identifier` must be built **identically** in capture and replay.

Recommended identifier builders:
```ts
export function httpIdentifier(method: string, url: string) {
  return `${method.toUpperCase()} ${url}`;
}
export function redisIdentifier(cmd: string, args: string[]) {
  return `${cmd.toUpperCase()} ${args.join(" ")}`.trim();
}
export function pgIdentifier(sql: string) {
  return normalizeSql(sql); // optional; MUST be consistent
}
```

---

## 7) Matching model (v4) + Topology matcher (v2/v3) as an optional matcher

### 7.1 MatcherAction + list (v4)
```ts
export type MatcherAction =
  | { action: "MOCK"; payload: any }
  | { action: "PASSTHROUGH" }
  | { action: "CONTINUE" };

export type MatcherFn = (
  span: import("@opentelemetry/api").Span | undefined,
  records: SoftprobeCassetteRecord[]
) => MatcherAction;

export class SoftprobeMatcher {
  private fns: MatcherFn[] = [];
  private records: SoftprobeCassetteRecord[] = [];

  use(fn: MatcherFn) { this.fns.push(fn); }
  clear() { this.fns = []; }
  _setRecords(records: SoftprobeCassetteRecord[]) { this.records = records; }

  match(): MatcherAction {
    const span = require("@opentelemetry/api").trace.getActiveSpan();
    for (const fn of this.fns) {
      const r = fn(span, this.records);
      if (r.action !== "CONTINUE") return r;
    }
    return { action: "CONTINUE" };
  }
}
```

**Policy note:** strict vs dev behavior is handled by wrappers, not matchers.

### 7.2 Typed bindings (v4) — extended to Redis/AMQP

Typed bindings encapsulate private keys. User code sees stable functions.

#### PostgresSpan
Keep the existing v4 `PostgresSpan.tagQuery()` and `.fromSpan()`.

#### RedisSpan (added)
```ts
import { trace, Span } from "@opentelemetry/api";

const REDIS = {
  protocol: "softprobe.redis.protocol",
  identifier: "softprobe.redis.identifier",
  cmd: "softprobe.redis.cmd",
  args_json: "softprobe.redis.args_json",
} as const;

export type RedisSpanData = {
  protocol: "redis";
  identifier: string;
  cmd: string;
  args: string[];
};

function set(span: Span | undefined, k: string, v: any) { if (span && v !== undefined) (span as any).setAttribute?.(k, v); }
function get(span: any, k: string) { return span?.attributes?.[k]; }
function activeSpan() { return trace.getActiveSpan(); }

export class RedisSpan {
  static tagCommand(cmd: string, args: string[], span: Span | undefined = activeSpan()) {
    set(span, REDIS.protocol, "redis");
    set(span, REDIS.cmd, cmd.toUpperCase());
    set(span, REDIS.identifier, `${cmd.toUpperCase()} ${args.join(" ")}`.trim());
    set(span, REDIS.args_json, JSON.stringify(args));
  }

  static fromSpan(span: Span | undefined): RedisSpanData | null {
    const protocol = get(span, REDIS.protocol);
    if (protocol !== "redis") return null;
    const identifier = get(span, REDIS.identifier);
    const cmd = get(span, REDIS.cmd);
    const args_json = get(span, REDIS.args_json);
    if (!identifier || !cmd) return null;
    const args = typeof args_json === "string" ? (JSON.parse(args_json) ?? []) : [];
    return { protocol: "redis", identifier, cmd, args };
  }
}
```

#### AMQPSpan (minimal placeholder)
```ts
const AMQP = {
  protocol: "softprobe.amqp.protocol",
  identifier: "softprobe.amqp.identifier",
  op: "softprobe.amqp.op",
  exchange: "softprobe.amqp.exchange",
  routingKey: "softprobe.amqp.routingKey",
} as const;

export type AmqpSpanData = {
  protocol: "amqp";
  identifier: string;
  op: "publish" | "consume";
  exchange?: string;
  routingKey?: string;
};

export class AmqpSpan {
  static tagPublish(exchange: string, routingKey: string, span?: any) {
    // implement same pattern as RedisSpan
  }
  static fromSpan(span: any): AmqpSpanData | null {
    // implement same pattern as RedisSpan
    return null;
  }
}
```

### 7.3 Default matcher (v4)
Flat key match:
- derive (protocol, identifier) via typed bindings
- pick recorded outbound record(s)
- handle loops via per-key call sequence mapping

### 7.4 Optional topology-aware matcher (v2/v3)
Implemented as a matcher fn inserted before the default matcher.

Heuristic:
- candidates filtered by protocol+identifier
- prefer recorded candidates whose recorded parent span name matches live parent span name
- handle loops with wrap-around

```ts
import { trace } from "@opentelemetry/api";

export function createTopologyMatcher(): MatcherFn {
  const callSeq = new Map<string, number>();

  return (span, records) => {
    if (!span) return { action: "CONTINUE" };

    const pg = PostgresSpan.fromSpan(span);
    const http = HttpSpan.fromSpan(span);
    const redis = RedisSpan.fromSpan(span);

    const key =
      pg ? { protocol: "postgres" as const, identifier: pg.identifier } :
      http ? { protocol: "http" as const, identifier: http.identifier } :
      redis ? { protocol: "redis" as const, identifier: redis.identifier } :
      null;

    if (!key) return { action: "CONTINUE" };

    const liveParentName = (span as any)?._parentSpanName ?? "root";

    const candidates = records.filter(r =>
      r.type === "outbound" &&
      r.protocol === key.protocol &&
      r.identifier === key.identifier
    );
    if (candidates.length === 0) return { action: "CONTINUE" };

    const bySpanId = new Map(records.map(r => [r.spanId, r]));
    const lineageMatches = candidates.filter(c => {
      if (!c.parentSpanId) return liveParentName == "root";
      const parent = bySpanId.get(c.parentSpanId);
      return (parent?.spanName ?? "root") === liveParentName;
    });

    const pool = lineageMatches.length > 0 ? lineageMatches : candidates;

    const seqKey = `${key.protocol}::${key.identifier}::${liveParentName}`;
    const n = callSeq.get(seqKey) ?? 0;
    const picked = pool[n] ?? pool[0];
    callSeq.set(seqKey, n + 1);

    return { action: "MOCK", payload: picked.responsePayload };
  };
}
```

---

## 8) Replay context, record loading, and inbound response retrieval (v3.5)

### 8.1 `runWithContext()` loads records once
```ts
export async function runWithContext(
  opts: { traceId?: string; cassettePath: string },
  fn: () => Promise<void>
) {
  const records = await loadNdjson(opts.cassettePath, opts.traceId);

  const m = softprobe.getActiveMatcher();
  m._setRecords(records);

  softprobe._setInboundRecord(findInbound(records));

  return softprobe._als.run(
    { traceId: opts.traceId, cassettePath: opts.cassettePath },
    fn
  );
}
```

### 8.2 Streaming NDJSON loader
```ts
import fs from "fs";
import readline from "readline";

export async function loadNdjson(path: string, traceId?: string) {
  const out: SoftprobeCassetteRecord[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as SoftprobeCassetteRecord;
    if (!traceId || rec.traceId === traceId) out.push(rec);
  }
  return out;
}

function findInbound(records: SoftprobeCassetteRecord[]) {
  return records.find(r => r.type === "inbound" && r.protocol === "http");
}
```

### 8.3 `getRecordedInboundResponse()`
Expose:
```ts
softprobe.getRecordedInboundResponse(): SoftprobeCassetteRecord | undefined
```

---

## 9) Replay interceptors (implementation details)

### 9.1 Postgres replay (shimmer) + import-order guard
```ts
import shimmer from "shimmer";

export function patchPostgresReplay(softprobe: any) {
  let pg: any; try { pg = require("pg"); } catch { return; }

  // Import-order guard: must shim before OTel wraps
  if ((pg.Client.prototype.query as any).__wrapped) {
    throw new Error(
      "[Softprobe FATAL] OTel already wrapped pg. Import 'softprobe/init' BEFORE OTel initialization."
    );
  }

  shimmer.wrap(pg.Client.prototype, "query", function (originalQuery) {
    return function softprobeReplayQuery(...args: any[]) {
      const a0 = args[0];
      const sql = typeof a0 === "string" ? a0 : a0?.text;
      const values = typeof a0 === "string" ? args[1] : a0?.values;

      if (typeof sql === "string") {
        PostgresSpan.tagQuery(sql, Array.isArray(values) ? values : undefined);
      }

      const r = softprobe.getActiveMatcher().match();

      if (r.action === "MOCK") {
        const payload = r.payload;
        const rows = Array.isArray(payload) ? payload : (payload?.rows ?? []);
        const rowCount = payload?.rowCount ?? rows.length;
        const command = payload?.command ?? "MOCKED";
        const pgResult = { rows, rowCount, command };

        const isCb = typeof args[args.length - 1] === "function";
        if (isCb) { process.nextTick(() => args[args.length - 1](null, pgResult)); return; }
        return Promise.resolve(pgResult);
      }

      if (r.action === "PASSTHROUGH") return originalQuery.apply(this, args);

      // CONTINUE policy is wrapper-owned (strict vs dev)
      if (process.env.SOFTPROBE_STRICT_REPLAY === "1") {
        throw new Error("Softprobe replay: no match for pg.query");
      }
      return originalQuery.apply(this, args);
    };
  });
}
```

### 9.2 HTTP replay (MSW interceptors) + ignoreUrls + consistent error shape
```ts
import { BatchInterceptor } from "@mswjs/interceptors";
import { ClientRequestInterceptor } from "@mswjs/interceptors/ClientRequest";
import { FetchInterceptor } from "@mswjs/interceptors/fetch";
import { softprobeConfig } from "../utils/config";

export function setupUniversalHttpReplay(softprobe: any) {
  const httpInterceptor = new BatchInterceptor({
    name: "softprobe-http-replay",
    interceptors: [new ClientRequestInterceptor(), new FetchInterceptor()],
  });

  httpInterceptor.apply();

  httpInterceptor.on("request", async ({ request, controller }) => {
    try {
      const url = typeof request.url === "string" ? request.url : request.url.toString();
      if (softprobeConfig.shouldIgnore(url)) return; // allow passthrough

      let bodyText: string | undefined;
      try { bodyText = await request.clone().text(); } catch {}

      HttpSpan.tagRequest(request.method, url, bodyText);

      const r = softprobe.getActiveMatcher().match();

      if (r.action === "MOCK") {
        const p = r.payload ?? {};
        controller.respondWith(new Response(p.body ?? "", {
          status: p.status ?? p.statusCode ?? 200,
          headers: p.headers ?? {},
        }));
        return;
      }

      if (r.action === "PASSTHROUGH") return;

      if (process.env.SOFTPROBE_STRICT_REPLAY === "1") {
        controller.respondWith(new Response(
          JSON.stringify({ error: "[Softprobe] No recorded traces found for http request" }),
          { status: 500, headers: { "x-softprobe-error": "true", "content-type": "application/json" } }
        ));
      }
      // else CONTINUE: do nothing => real request proceeds
    } catch (err: any) {
      controller.respondWith(new Response(
        JSON.stringify({ error: "Softprobe Replay Error", details: err?.message ?? String(err) }),
        { status: 500, headers: { "x-softprobe-error": "true", "content-type": "application/json" } }
      ));
    }
  });
}
```

### 9.3 Redis replay (shimmer)
Patch either node-redis v4 command path or ioredis. Example for a `sendCommand`-style API:
```ts
import shimmer from "shimmer";

export function patchRedisReplay(redisClientProto: any, softprobe: any) {
  shimmer.wrap(redisClientProto, "sendCommand", function (original) {
    return function softprobeSendCommand(cmd: any, ...rest: any[]) {
      const name = cmd?.name ?? cmd?.command ?? cmd?.[0];
      const args = cmd?.args ?? cmd?.[1] ?? [];
      const cmdName = String(name || "").toUpperCase();
      const cmdArgs = Array.isArray(args) ? args.map(String) : [];

      RedisSpan.tagCommand(cmdName, cmdArgs);

      const r = softprobe.getActiveMatcher().match();
      if (r.action === "MOCK") return Promise.resolve(r.payload);
      if (r.action === "PASSTHROUGH") return original.apply(this, arguments as any);

      if (process.env.SOFTPROBE_STRICT_REPLAY === "1") {
        throw new Error("Softprobe replay: no match for redis command");
      }
      return original.apply(this, arguments as any);
    };
  });
}
```

---

## 10) Production capture engine (v3.5)

### 10.1 NDJSON write queue (single-threaded, flush-on-exit)
Requirements:
- Async append queue to prevent interleaving.
- `maxQueueSize` safety valve (drop & count) under pressure.
- Best-effort flush on `exit`, `SIGINT`, `SIGTERM`.

### 10.2 HTTP payload tapping without consuming streams
Use safe stream tap utilities (PassThrough/tee pattern) with:
- Never throw from production hooks.
- Payload max-size circuit breaker.
- Do not starve original stream consumers.

### 10.3 Capture hook contracts (must be verified per instrumentation)
Mandate: verify hook signatures against real instrumentation packages.

Examples of “gotchas”:
- Postgres query text is in `requestHook(span, { query: { text, values } })`
- Redis hook may be positional args: `responseHook(span, cmdName, cmdArgs, response)`

### 10.4 What gets recorded
- **Inbound HTTP**: request body + response status/body.
- **Outbound HTTP**: request body + response status/body.
- **Outbound Postgres**: query identifier + rows/rowCount/command (or rows only; be consistent).
- **Outbound Redis**: cmd+args + response.

All written as NDJSON `SoftprobeCassetteRecord` lines.

---

## 11) E2E testing constraints (Jest module loader)

Many OTel instrumentations rely on `require-in-the-middle`. Jest replaces Node’s native `require`, so pg/redis/amqp instrumentation often won’t activate inside Jest.

Workaround:
- Run capture workload in a **child process** using native Node require, then assert on output NDJSON.

Also note:
- `OTEL_TRACES_EXPORTER=none` produces non-recording spans; capture will see nothing.

---

## 12) Implementation checklist (v4.1)

### Capture
- [ ] Config loader (`.softprobe/config.yml`) + precompiled ignore regexes
- [ ] CassetteStore write queue + exit flush
- [ ] HTTP stream tap utilities + payload size cap
- [ ] Protocol capture hooks with tests validating hook signatures
- [ ] NDJSON schema v4.1 (version field, identifiers consistent)
- [ ] Inbound capture support and retrieval helper

### Replay
- [ ] Import-order guard for DB shims
- [ ] pg shimmer wrapper using `PostgresSpan.tagQuery`
- [ ] HTTP interceptors using `HttpSpan.tagRequest` + ignoreUrls
- [ ] redis wrapper + `RedisSpan.tagCommand`
- [ ] strict mode behavior handled in wrappers (not in matcher)

### Matching
- [ ] Matcher list (user matchers first)
- [ ] Optional `TopologyMatcher` (insert before default)
- [ ] Default matcher last (flat protocol+identifier, loop callSeq)

---

## 13) Appendix: Default matcher sketch

```ts
export function createDefaultMatcher(): MatcherFn {
  const callSeq = new Map<string, number>();

  return (span, records) => {
    if (!span) return { action: "CONTINUE" };

    const pg = PostgresSpan.fromSpan(span);
    const http = HttpSpan.fromSpan(span);
    const redis = RedisSpan.fromSpan(span);

    const key =
      pg ? { protocol: "postgres" as const, identifier: pg.identifier } :
      http ? { protocol: "http" as const, identifier: http.identifier } :
      redis ? { protocol: "redis" as const, identifier: redis.identifier } :
      null;

    if (!key) return { action: "CONTINUE" };

    const candidates = records.filter(r =>
      r.type === "outbound" &&
      r.protocol === key.protocol &&
      r.identifier === key.identifier
    );

    if (candidates.length === 0) return { action: "CONTINUE" };

    const seqKey = `${key.protocol}::${key.identifier}`;
    const n = callSeq.get(seqKey) ?? 0;
    const picked = candidates[n] ?? candidates[0];
    callSeq.set(seqKey, n + 1);

    return { action: "MOCK", payload: picked.responsePayload };
  };
}
```

---

## 14) Server-Side Integration (Inbound)

### 14.1 Synchronous Initialization

Because `softprobe/init` must be the first import, the logic you provided correctly uses synchronous `require` calls. This ensures that when the server (Express/Fastify) starts, the drivers are already wrapped with the necessary Capture or Replay logic.

### 14.2 The Role of Environment Variables

* **`SOFTPROBE_MODE=CAPTURE`**: Loads the `CassetteStore` and applies instrumentations that tap into request/response streams to write to the NDJSON side-channel.
* **`SOFTPROBE_MODE=REPLAY`**: Loads the Matcher list and activates the shims (Postgres, Redis, HTTP) that return mocked payloads instead of making real network calls.

---

## 15) Automatic Mock Injection via Environment & Context

By combining `process.env` with OTel's native context, we achieve a "Virtual Environment" that requires zero code changes to the application logic.

### 15.1 Coordination Flow

1. **Boot (Global):** The app starts with `SOFTPROBE_MODE=REPLAY`. All database/HTTP drivers are now "stub-ready".
2. **Request Entry (Local):** An incoming request arrives. Softprobe's server middleware (Express/Fastify) uses the native OTel context to find the `traceId`.
3. **Context Priming:** The middleware calls `softprobe.activateReplayForContext(traceId)`. This links the current `AsyncLocalStorage` to the specific records loaded from the `SOFTPROBE_CASSETTE_PATH`.
4. **Automatic Injection:** When the App code calls `db.query()`, the Postgres shim sees the global `REPLAY` mode and the local `traceId`, finds the matching SQL in the cassette, and injects the result back into the App.

### 15.2 Downstream Propagation

To ensure internal microservice calls are also mocked, Softprobe injects the mode into the OTel baggage:

```ts
// Inside server middleware
if (process.env.SOFTPROBE_MODE === 'REPLAY') {
  const entry = { value: 'REPLAY', metadata: 'softprobe' };
  const newBaggage = baggage.setEntry(propagation.getBaggage(context.active()), 'softprobe-mode', entry);
  // This baggage is automatically sent via 'otlp' or 'w3c' headers to the next service
}

```

---

## 16) Updated Server-Side Components (v4.1)

### 16.1 Express Middleware (Environment Aware)

```ts
export function softprobeExpressMiddleware(req: any, res: any, next: any) {
  const span = trace.getActiveSpan();
  const traceId = span?.spanContext().traceId;

  if (process.env.SOFTPROBE_MODE === 'REPLAY' && traceId) {
    // Prime the Matcher for this specific trace
    softprobe.getActiveMatcher()._setRecords(softprobe.getRecordsForTrace(traceId));
  }

  if (process.env.SOFTPROBE_MODE === 'CAPTURE') {
    const originalSend = res.send;
    res.send = function(body: any) {
      CaptureEngine.queueInboundResponse(traceId, {
        status: res.statusCode,
        body: body,
        identifier: `${req.method} ${req.path}`
      });
      return originalSend.apply(res, arguments);
    };
  }

  next();
}

```

### 16.2 Fastify Plugin (Environment Aware)

Fastify hooks should be conditionally added based on the environment variable to minimize overhead.

```ts
export const softprobeFastifyPlugin = async (fastify: FastifyInstance) => {
  if (process.env.SOFTPROBE_MODE === 'CAPTURE') {
    fastify.addHook('onSend', async (request, reply, payload) => {
      const traceId = trace.getActiveSpan()?.spanContext().traceId;
      CaptureEngine.queueInboundResponse(traceId, {
        status: reply.statusCode,
        body: payload
      });
      return payload;
    });
  }
};

```

### Automatic Middleware Hooking
When softprobe/init runs, it registers a "mutator" for known server frameworks. This mutator essentially "wraps" the framework's constructor or initialization method.

For Express:
Softprobe patches express.application.lazyrouter. When the first route or middleware is added to an Express app, Softprobe automatically pushes its softprobeExpressMiddleware to the top of the internal middleware stack (app._router.stack).

For Fastify:
Softprobe patches the Fastify factory function. When a new instance is created, it immediately calls fastify.addHook() for preHandler and onSend before the user code even has a chance to define routes.

In `init.ts` logic, the `applyAutoInstrumentationMutator()` call handles this framework-specific "wrapping" based on the `SOFTPROBE_MODE`:

```TypeScript
// Inside softprobe/init
if (mode === 'CAPTURE') {
  // ... store setup ...
  // This automatically finds Express/Fastify in node_modules and injects hooks
  applyAutoInstrumentationMutator(); 
}

if (mode === 'REPLAY') {
  // Replay patches also happen here synchronously (Task 11.1.3)
  setupHttpReplayInterceptor(); 
  // etc.
}
```
---

## 17) Implementation Checklist Refinement

* **[ ] Sync Bootstrapping:** Ensure `SOFTPROBE_MODE` is checked at the very top of `instrumentation.ts` before `NodeSDK` starts.
* **[ ] Matcher Scoping:** Verify the `SoftprobeMatcher` uses the active OTel context to select records, preventing cross-test data leakage.
* **[ ] NDJSON Flush:** Since you are using a global `beforeExit` listener, ensure it handles both `SIGINT` and `SIGTERM` for production safety.


---

# Softprobe Consolidated Design (v5.2) — Unified OTel Context & YAML Configuration

## 1. Background and The "Bootstrap" Problem

Previous versions relied on `process.env.SOFTPROBE_MODE` to decide whether to no-op database connections. However, tests often run in "Replay" mode without global environment flags, causing database drivers to attempt real connections during the application's "pre-warm" phase (module evaluation).

By moving all state into the **OpenTelemetry (OTel) Context** and seeding a **Global Default** from a YAML file, we ensure the system is "Mock-Ready" before the first line of application code executes.

---

## 2. Configuration (`.softprobe/config.yml`)

We move away from environment variables to a structured configuration file. The `outputFile` from previous versions is renamed to `cassettePath` to reflect its dual role as the destination for Capture and the source for Replay.

```yaml
# .softprobe/config.yml
mode: "REPLAY"                   # Global default: CAPTURE, REPLAY, or PASSTHROUGH
cassettePath: "./cassettes.ndjson" # Unified path for recording and playback

capture:
  maxPayloadSize: 1048576        # 1MB circuit breaker
  
replay:
  strict: true                   # Fail if no match found
  ignoreUrls:
    - "localhost:431[78]"        # OTel collector
    - "/v1/traces"

```

---

## 3. The Unified Context Schema

Softprobe state is stored under a unique OTel `ContextKey`. This allows the "Mode" and "Matcher" to propagate automatically across service boundaries via OTel's native propagation logic.

```typescript
import { createContextKey, Context, context } from "@opentelemetry/api";

export interface SoftprobeContextValue {
  mode: 'CAPTURE' | 'REPLAY' | 'PASSTHROUGH';
  cassettePath: string;
  traceId?: string;
  matcher?: SoftprobeMatcher;
  inboundRecord?: SoftprobeCassetteRecord;
}

export const SOFTPROBE_CONTEXT_KEY = createContextKey('softprobe_context');

```

---

## 4. Context Management & Priority Logic

To solve the bootstrap issue, the system uses a hierarchy: **Active Context** (Specific) > **Global Default** (General).

```typescript
// Initialized at boot from YAML
let globalDefault: SoftprobeContextValue;

export function initGlobalContext(config: any) {
  globalDefault = {
    mode: config.mode || 'PASSTHROUGH',
    cassettePath: config.cassettePath
  };
}

/**
 * Priority: 
 * 1. Values set explicitly in the current OTel Context (e.g., via runWithContext)
 * 2. Values from the global config.yml
 */
export function getSoftprobeContext(ctx: Context = context.active()): SoftprobeContextValue {
  const activeValue = ctx.getValue(SOFTPROBE_CONTEXT_KEY) as SoftprobeContextValue;
  return activeValue || globalDefault;
}

```

---

## 5. Implementation: The "Shim" Layer

Shims for Postgres, Redis, and HTTP now consult the Unified Context. This ensures that even if a database `connect()` is called at the top of a file, it checks the YAML-seeded global default and no-ops the connection if the mode is `REPLAY`.

### 5.1 Postgres Connection No-Op

```typescript
shimmer.wrap(pg.Client.prototype, "connect", function (originalConnect) {
  return function wrappedConnect(this: unknown, ...args: unknown[]) {
    const spCtx = getSoftprobeContext(); // Checks Active Context -> then Global YAML Default

    if (spCtx.mode === 'REPLAY') {
      return Promise.resolve(); // Prevent network activity during bootstrap
    }
    return (originalConnect as Function).apply(this, args);
  };
});

```

---

## 6. The Developer API

The `runWithContext` API allows local overrides (like specific trace matching) within a larger application that may have a different global mode.

```typescript
import { softprobe } from "softprobe";

it("replays even if the DB is disconnected", async () => {
  // This sets an Active OTel Context that overrides the Global YAML Mode
  await softprobe.runWithContext(
    { traceId: "test-123", mode: "REPLAY" }, 
    async () => {
      const res = await fetch("http://localhost:3000/data");
      expect(res.status).toBe(200);
    }
  );
});

```

---

## 7. Holistic Design Overview

| Component | Responsibility | Config Source |
| --- | --- | --- |
| **Config Manager** | Synchronously loads YAML at process start. | `.softprobe/config.yml` |
| **Global Context** | Seeks global `mode` and `cassettePath` to protect bootstrap connections. | `config.yml` |
| **Active Context** | Manages per-request or per-test logic using OTel `AsyncLocalStorage`. | `runWithContext()` |
| **Cassette Store** | Writes (Capture) or Reads (Replay) from the unified `cassettePath`. | `config.yml` |

---

## 8. Final Implementation Checklist

* **[ ] Config Migration**: Rename all instances of `outputFile` to `cassettePath` in the YAML parser and internal interfaces.
* **[ ] Sync Initialization**: Ensure `initGlobalContext` is called in `softprobe/init` before any OTel instrumentation starts.
* **[ ] Context Priority**: Verify `getSoftprobeContext` correctly falls back to the global YAML settings when OTel context is missing.
* **[ ] Propagation**: Ensure `softprobe-mode` from the YAML is injected into OTel Baggage for microservice-to-microservice consistency.
* **[ ] Bootstrap Test**: Create a test case where a DB `connect()` is called at the module level (outside an `it` block) to ensure it no-ops correctly based on YAML.