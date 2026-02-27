/**
 * Key extraction and candidate filtering for default matcher (design §7.3).
 * Derives { protocol, identifier } from a span; filters outbound records by key.
 */

import type {
  MatcherAction,
  MatcherFn,
  SoftprobeCassetteRecord,
} from '../../types/schema';
import { PostgresSpan } from '../bindings/postgres-span';
import { RedisSpan } from '../bindings/redis-span';
import { HttpSpan } from '../bindings/http-span';

/** Key used for flat matching: protocol + identifier. */
export type SpanKey = {
  protocol: 'postgres' | 'redis' | 'http';
  identifier: string;
};

/** Span-like with readable attributes (OTel Span or test span). */
type ReadableSpan = { attributes?: Record<string, unknown> } | undefined;

/**
 * Extracts matching key from a span using PostgresSpan, RedisSpan, and HttpSpan.
 * Returns the first non-null fromSpan result as { protocol, identifier }; unknown span yields null.
 */
export function extractKeyFromSpan(span: ReadableSpan): SpanKey | null {
  const pg = PostgresSpan.fromSpan(span);
  if (pg) return { protocol: 'postgres', identifier: pg.identifier };

  const redis = RedisSpan.fromSpan(span);
  if (redis) return { protocol: 'redis', identifier: redis.identifier };

  const http = HttpSpan.fromSpan(span);
  if (http) return { protocol: 'http', identifier: http.identifier };

  return null;
}

/**
 * Returns only outbound records whose protocol and identifier match the key.
 */
export function filterOutboundCandidates(
  records: SoftprobeCassetteRecord[],
  key: SpanKey
): SoftprobeCassetteRecord[] {
  return records.filter(
    (r) =>
      r.type === 'outbound' &&
      r.protocol === key.protocol &&
      r.identifier === key.identifier
  );
}

function seqKey(key: SpanKey): string {
  return `${key.protocol}::${key.identifier}`;
}

/**
 * Per-key call sequence for default matcher: tracks the next candidate index
 * per (protocol, identifier). getAndIncrement returns the current index and advances.
 */
export class CallSeq {
  private next = new Map<string, number>();

  /**
   * Returns the current index for this key and increments for the next call.
   */
  getAndIncrement(key: SpanKey): number {
    const k = seqKey(key);
    const idx = this.next.get(k) ?? 0;
    this.next.set(k, idx + 1);
    return idx;
  }
}

/**
 * Returns a MatcherFn that uses extractKeyFromSpan, filterOutboundCandidates,
 * and CallSeq to pick an outbound record and return MOCK with its responsePayload.
 */
export function createDefaultMatcher(): MatcherFn {
  const callSeq = new CallSeq();
  return (span, records): MatcherAction => {
    const key = extractKeyFromSpan(span as ReadableSpan);
    if (!key) return { action: 'CONTINUE' };
    const candidates = filterOutboundCandidates(records, key);
    if (candidates.length === 0) return { action: 'CONTINUE' };
    const idx = callSeq.getAndIncrement(key);
    if (idx >= candidates.length) return { action: 'CONTINUE' };
    const record = candidates[idx];
    return { action: 'MOCK', payload: record?.responsePayload, traceId: record?.traceId };
  };
}
