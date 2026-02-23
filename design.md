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
