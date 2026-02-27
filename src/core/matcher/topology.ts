/**
 * Topology-aware matching helpers (design §7.4).
 * Read live parent name; build bySpanId index; filter candidates; createTopologyMatcher.
 */

import type { MatcherAction, MatcherFn, SoftprobeCassetteRecord } from '../../types/schema';
import {
  extractKeyFromSpan,
  filterOutboundCandidates,
  type SpanKey,
} from './extract-key';

/** Span-like with optional internal _parentSpanName (test or OTel plumbing). */
type SpanWithParent = { _parentSpanName?: string } | undefined;

/**
 * Returns the live parent span name for topology matching.
 * If the span has _parentSpanName (set by instrumentation or tests), returns it; otherwise "root".
 */
export function getLiveParentName(span: SpanWithParent): string {
  return (span as any)?._parentSpanName ?? 'root';
}

/**
 * Builds a map from spanId to record for lineage lookup (design §7.4).
 * Enables looking up a record's parent via bySpanId.get(record.parentSpanId).
 */
export function buildBySpanIdIndex(
  records: SoftprobeCassetteRecord[]
): Map<string, SoftprobeCassetteRecord> {
  return new Map(records.map((r) => [r.spanId, r]));
}

/**
 * Filters records to outbound candidates matching protocol+identifier (design §7.4).
 * Same semantics as flat matcher's filterOutboundCandidates.
 */
export function filterCandidatesByKey(
  records: SoftprobeCassetteRecord[],
  key: SpanKey
): SoftprobeCassetteRecord[] {
  return filterOutboundCandidates(records, key);
}

/**
 * Prefers candidates whose recorded parent spanName matches live parent (design §7.4).
 * Returns lineageMatches when non-empty, otherwise returns all candidates (fallback pool).
 */
export function selectLineagePool(
  candidates: SoftprobeCassetteRecord[],
  bySpanId: Map<string, SoftprobeCassetteRecord>,
  liveParentName: string
): SoftprobeCassetteRecord[] {
  const lineageMatches = candidates.filter((c) => {
    if (!c.parentSpanId) return liveParentName === 'root';
    const parent = bySpanId.get(c.parentSpanId);
    return (parent?.spanName ?? 'root') === liveParentName;
  });
  return lineageMatches.length > 0 ? lineageMatches : candidates;
}

/**
 * Returns a MatcherFn that prefers candidates whose recorded parent spanName matches
 * the live parent, with per-(protocol, identifier, liveParentName) call sequencing (design §7.4).
 */
export function createTopologyMatcher(): MatcherFn {
  const callSeq = new Map<string, number>();

  return (span, records): MatcherAction => {
    const key = extractKeyFromSpan(span as { attributes?: Record<string, unknown> });
    if (!key) return { action: 'CONTINUE' };

    const liveParentName = getLiveParentName(span as SpanWithParent);
    const candidates = filterCandidatesByKey(records, key);
    if (candidates.length === 0) return { action: 'CONTINUE' };

    const bySpanId = buildBySpanIdIndex(records);
    const pool = selectLineagePool(candidates, bySpanId, liveParentName);

    const seqKey = `${key.protocol}::${key.identifier}::${liveParentName}`;
    const n = callSeq.get(seqKey) ?? 0;
    const picked = pool[n];
    callSeq.set(seqKey, n + 1);
    if (!picked) return { action: 'CONTINUE' };

    return { action: 'MOCK', payload: picked.responsePayload };
  };
}
