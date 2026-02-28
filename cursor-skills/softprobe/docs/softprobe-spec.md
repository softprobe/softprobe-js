# Softprobe Product Spec (Portable)

This document is the portable product baseline for using Softprobe in any repository.

## Purpose

Softprobe provides deterministic record/replay for backend traffic:

- capture inbound and outbound dependency behavior to NDJSON
- replay using the same trace cassette
- compare replayed responses with current service behavior

## Runtime Model

Softprobe centers around four units:

1. `Context`: request/test scoped state in OpenTelemetry context (`mode`, `traceId`, cassette, matcher).
2. `Cassette`: storage interface (`loadTrace()`, `saveRecord(record)`, optional `flush()`).
3. `Matcher`: resolves outbound calls during replay (`MOCK`, `PASSTHROUGH`, `CONTINUE`).
4. `Wrappers/Interceptors`: protocol integrations (HTTP/Postgres/Redis).

Portable integration default:

- initialize with `@softprobe/softprobe-js/init` loaded before app/server code
- avoid internal package path imports; use public package entry points only

## Modes

- `CAPTURE`: writes inbound/outbound records to cassette.
- `REPLAY`: loads records and resolves outbound calls through matcher.
- `PASSTHROUGH`: allows live calls without capture/replay matching.

## Coordination Headers

- `x-softprobe-mode`
- `x-softprobe-trace-id`

These may override runtime per request when middleware supports header coordination.

## Cassette Layout

- configure a cassette directory
- one file per trace: `{cassetteDirectory}/{traceId}.ndjson`
- records are append-only NDJSON objects

## Matching Baseline

Default candidate key is `(protocol, identifier)`.
Wrappers annotate span attributes first, then matcher resolves deterministic sequence.

## Strict Boundary

Matcher returns intent only; wrappers enforce strict replay/failure policy.
