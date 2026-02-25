# Softprobe Cassette Design (NDJSON)

This document defines cassette responsibilities and NDJSON behavior.

Related docs:
- [Main design](./design.md)
- [Context design](./design-context.md)

---

## 1) Goals

- define a stable cassette interface for both capture and replay
- keep transport/storage behind one abstraction
- keep NDJSON as the baseline storage format

---

## 2) Cassette Interface

```ts
export interface Cassette {
  /** REPLAY: read records for one trace */
  loadTrace(traceId: string): Promise<SoftprobeCassetteRecord[]>;

  /** CAPTURE: append one record for one trace */
  saveRecord(traceId: string, record: SoftprobeCassetteRecord): Promise<void>;

  /** optional flush hook for graceful shutdown */
  flush?(): Promise<void>;
}
```

Design notes:
- `traceId` is the logical partition key.
- call sites should not depend on NDJSON internals.
- capture and replay both use the same cassette object from active context.

---

## 3) NDJSON Record Model

```ts
export type SoftprobeCassetteRecord = {
  version: '4.1';
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  spanName?: string;
  timestamp: string;

  type: 'inbound' | 'outbound' | 'metadata';
  protocol: 'http' | 'postgres' | 'redis' | 'amqp' | 'grpc';
  identifier: string;

  requestPayload?: unknown;
  responsePayload?: unknown;
  statusCode?: number;
  error?: { message: string; stack?: string };
};
```

Rules:
- one JSON object per line
- append-only writes
- optional read filter by `traceId`

---

## 4) Capture Behavior

Capture path uses active context values:
- `mode === 'CAPTURE'`
- `traceId`
- `cassette`

Writing contract:
- inbound and outbound hooks call `cassette.saveRecord(traceId, record)`
- writes are best-effort and non-blocking where possible
- queued writes should avoid line interleaving

Flush contract:
- call `cassette.flush?.()` on graceful shutdown or explicit flush points

---

## 5) Replay Behavior

Replay path uses active context values:
- `mode === 'REPLAY'`
- `traceId`
- `cassette`

Read contract:
- `SoftprobeContext.run()` calls `cassette.loadTrace(traceId)` once per scoped run
- loaded records seed matcher state for wrappers/interceptors

---

## 6) NDJSON Adapter

Reference adapter: `NdjsonCassette`

Responsibilities:
- implement `loadTrace` via stream loader
- implement `saveRecord` via write queue/store accessor
- expose optional `flush` for drain-on-exit

This keeps the `Cassette` contract stable while allowing alternative backends later.
