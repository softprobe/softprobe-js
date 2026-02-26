import type { Span } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

/**
 * Result of a custom matcher:
 * - MOCK: return the given payload; no tree matching, no network.
 * - CONTINUE: fall through to default tree matching; the call is still replayed from the recording (no live network).
 * - PASSTHROUGH: request that this call go to the live network; in strict mode the engine throws (not allowed).
 */
export type MatcherResult =
  | { action: 'MOCK'; payload: unknown }
  | { action: 'CONTINUE' }
  | { action: 'PASSTHROUGH' };

/**
 * V4 matcher result: discriminated union. Wrappers branch on action; only MOCK carries payload.
 * Design §7.1: first non-CONTINUE wins; matchers do not execute passthrough.
 */
export type MatcherAction =
  | { action: 'MOCK'; payload: unknown; traceId?: string }
  | { action: 'PASSTHROUGH' }
  | { action: 'CONTINUE' };

/**
 * V4 matcher function: (span, records) => MatcherAction. Used by SoftprobeMatcher list.
 * Design §7.1: first non-CONTINUE return wins; matchers do not execute passthrough.
 * Input contract: span attributes are the canonical source for matching keys
 * (e.g. `softprobe.protocol`, `softprobe.identifier`). Raw dependency call args
 * are expected to be transformed into span attributes by wrappers/instrumentation.
 */
export type MatcherFn = (
  span: Span | undefined,
  records: SoftprobeCassetteRecord[]
) => MatcherAction;

/** Custom matcher function. Evaluated before default tree matching. */
export type CustomMatcherFn = (
  liveRequest: MatchRequest,
  recordedSpans: ReadableSpan[]
) => MatcherResult;

export interface SoftprobeAttributes {
  'softprobe.protocol': 'http' | 'postgres' | 'redis' | 'amqp';
  'softprobe.identifier': string;
  'softprobe.request.body'?: string;
  'softprobe.response.body'?: string;
}

/** Runtime execution mode for Softprobe context. */
export type SoftprobeMode = 'CAPTURE' | 'REPLAY' | 'PASSTHROUGH';

/**
 * Generic cassette storage interface for trace records.
 * Task 13.3: Cassette is bound to one traceId at creation; load/save do not take traceId.
 */
export interface Cassette {
  loadTrace(): Promise<SoftprobeCassetteRecord[]>;
  saveRecord(record: SoftprobeCassetteRecord): Promise<void>;
  flush?(): Promise<void>;
}

export interface SoftprobeRunOptions {
  mode: SoftprobeMode;
  storage: Cassette;
  traceId: string;
  matcher?: MatcherFn;
}

/** V4.1 protocol discriminator (cassette + bindings). */
export type Protocol = 'http' | 'postgres' | 'redis' | 'amqp' | 'grpc';

/** V4.1 cassette record direction. */
export type RecordType = 'inbound' | 'outbound' | 'metadata';

/**
 * V4.1 NDJSON cassette record: identity, topology, direction, matching keys, optional payloads.
 * Payloads are side-channel only (not in span attributes).
 */
export type SoftprobeCassetteRecord = {
  version: '4.1';
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  spanName?: string;
  timestamp: string;
  type: RecordType;
  protocol: Protocol;
  identifier: string;
  requestPayload?: unknown;
  responsePayload?: unknown;
  statusCode?: number;
  error?: { message: string; stack?: string };
};

/**
 * Minimal runtime guard for V4.1 cassette records. Returns true only when
 * the object has version "4.1" (does not validate other required keys).
 */
export function isCassetteRecord(obj: unknown): obj is SoftprobeCassetteRecord {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as Record<string, unknown>).version === '4.1'
  );
}

/** V3 side-channel cassette file format. */
export interface SoftprobeCassette {
  version: '3.0';
  records: SoftprobeCassetteRecord[];
}

export interface MatchRequest {
  protocol: string;
  identifier: string;
  requestBody?: unknown;
}
