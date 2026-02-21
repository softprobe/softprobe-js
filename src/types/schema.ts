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

export type SoftprobeTraceStore = Record<string, ReadableSpan[]>;

export interface MatchRequest {
  protocol: string;
  identifier: string;
  requestBody?: unknown;
}
