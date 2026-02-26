# Softprobe Matcher Design

This document defines matcher contracts and execution model.

Related docs:
- [Main design](./design.md)
- [Context design](./design-context.md)

---

## 1) Goals

- deterministic replay selection from cassette records
- composable matcher chain
- clear wrapper behavior for no-match cases

---

## 2) Contracts

```ts
export type MatcherAction =
  | { action: 'MOCK'; payload: unknown }
  | { action: 'PASSTHROUGH' }
  | { action: 'CONTINUE' };

export type MatcherFn = (
  span: import('@opentelemetry/api').Span | undefined,
  records: SoftprobeCassetteRecord[]
) => MatcherAction;
```

`SoftprobeMatcher` behavior:
- `use(fn)`: append matcher
- `clear()`: remove all matchers
- `_setRecords(records)`: set active record set
- `match()`: return first non-`CONTINUE`, else `CONTINUE`

Matcher input source:
- matchers read protocol/identifier from the current OTel span attributes
- wrappers/interceptors should tag the active span before calling `match()`
- `spanOverride` is a compatibility fallback only when no active span exists; it must mirror the same `softprobe.*` attribute contract

---

## 3) Default Matching

Default key: `(protocol, identifier)`

Key extraction source:
- extracted from span attributes (`softprobe.protocol`, `softprobe.identifier`)
- matcher API does not parse raw dependency call arguments directly
- wrappers convert call arguments into span attributes first (same contract as capture bindings)

Record filter:
- outbound only
- exact `protocol`
- exact `identifier`

Sequence policy:
- per-key call sequence map for repeated identical calls
- deterministic index progression

No candidate:
- return `CONTINUE` (wrapper decides strict/dev handling)

---

## 4) Optional Topology Matcher

Topology matcher can run before default matcher.

Heuristic:
- first filter by key `(protocol, identifier)`
- prefer candidates whose recorded parent span name matches live parent span name
- fallback to key-only candidate pool

This improves repeated-flow disambiguation without changing wrapper contracts.

---

## 5) Wrapper Policy Boundary

Matchers do not enforce strict mode.

Wrappers/interceptors own no-match behavior:
- strict replay: fail hard / return deterministic replay error
- dev mode: optional passthrough

This keeps matcher logic pure and reusable.

---

## 6) Context Coupling

Matcher is context-scoped:
- active matcher is read from `SoftprobeContext`
- replay run seeds matcher records from `cassette.loadTrace(traceId)`
- wrappers use current context only; avoid global mutable fallback
