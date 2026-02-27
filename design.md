# Softprobe Design (Main)

This is the primary entry point for Softprobe design.

Use this file for:
- system goals and boundaries
- end-to-end runtime flow
- links to focused design specifications

Use focused specs for implementation details:
- [Context model](./design-context.md)
- [Cassette model (NDJSON)](./design-cassette.md)
- [Matcher model](./design-matcher.md)

---

## 1) Scope

Softprobe provides record/replay for backend dependency calls and inbound responses.

Core capabilities:
- context-scoped execution via OpenTelemetry context
- capture to cassette (NDJSON)
- replay from cassette with deterministic matching
- strict replay mode for CI isolation

Out of scope:
- broad framework abstraction beyond wrappers/interceptors
- perfect fidelity for all protocols and workloads

---

## 2) Architectural Units

1. `Context`: holds request/test scoped Softprobe state (`mode`, `traceId`, cassette handle, matcher).
2. `Cassette`: reads/writes trace records through a stable interface (`loadTrace()`, `saveRecord(record)`, optional `flush()`).
3. `Matcher`: resolves outbound calls to recorded payloads.
4. `Wrappers/Interceptors`: protocol integrations (HTTP/Postgres/Redis).

Detailed specs are in:
- [design-context.md](./design-context.md)
- [design-cassette.md](./design-cassette.md)
- [design-matcher.md](./design-matcher.md)

---

## 3) Runtime Flow

### 3.1 Capture

1. Entry middleware/hook builds run options and calls `SoftprobeContext.run(options, fn)`.
2. Application and child spans run with active softprobe context.
3. Capture hooks write inbound/outbound records through the active cassette.
4. NDJSON is written directly by the cassette implementation (no in-process buffer; optional flush for future optimization).

### 3.2 Replay

1. Entry middleware/hook builds replay run options and calls `SoftprobeContext.run(options, fn)`.
2. `run()` loads trace records from cassette once per run and seeds matcher state.
3. Wrappers/interceptors call matcher:
   - `MOCK`: return recorded payload
   - `PASSTHROUGH`: call original
   - `CONTINUE`: wrapper strict/dev policy

---

## 4) Integration Rules

- `softprobe/init` must run before OTel auto-instrumentation wraps dependency modules.
- Softprobe stores data under a dedicated OTel context key.
- Header coordination may override per-request runtime with:
  - `x-softprobe-mode`
  - `x-softprobe-trace-id`
- Cassette layout is one file per trace: `{cassetteDirectory}/{traceId}.ndjson`.

### 4.1 One-line init

Init loads config from `SOFTPROBE_CONFIG_PATH` or default `./.softprobe/config.yml`, seeds global defaults (`mode`, `cassetteDirectory`, strict flags), then patches pg, redis, undici, and the HTTP interceptor before OTel runs.

The app loads `softprobe/init` once (e.g. first in instrumentation or `node -r softprobe/init`). When OTel later runs `sdk.start()`, it gets cached modules and wraps on top of our layer. No post-`sdk.start()` calls are required.

---

## 5) Design Doc Convention

Naming convention:
- main index: `design.md`
- focused specs: `design-<topic>.md`

Current focused specs:
- [design-context.md](./design-context.md)
- [design-cassette.md](./design-cassette.md)
- [design-matcher.md](./design-matcher.md)
