import { trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { MatchRequest, CustomMatcherFn } from '../../types/schema';

const RESPONSE_BODY_KEY = 'softprobe.response.body' as const;
const PROTOCOL_KEY = 'softprobe.protocol' as const;
const IDENTIFIER_KEY = 'softprobe.identifier' as const;

// This is obsolete, we should use the new matcher instead
// Deprecated: use SoftprobeMatcher instead
export class SemanticMatcher {
  private readonly recordedSpans: ReadableSpan[];
  /** Tracks call count per (protocol, identifier, liveParentName) for sequential N+1 resolution. */
  private readonly callSequenceMap = new Map<string, number>();
  /** User-registered matchers evaluated before the default tree-matching algorithm. */
  private readonly customMatchers: CustomMatcherFn[] = [];

  constructor(recordedSpans: ReadableSpan[]) {
    this.recordedSpans = recordedSpans;
  }

  /**
   * Registers a custom matcher. Custom matchers are run before the default tree-matching logic.
   * - MOCK: return the given payload (no tree matching, no network).
   * - CONTINUE: fall through to tree matching; the call is still replayed from the recording.
   * - PASSTHROUGH: request live network for this call; in strict mode throws (not allowed).
   */
  addMatcher(fn: CustomMatcherFn): void {
    this.customMatchers.push(fn);
  }

  /**
   * Finds a recorded span that matches the live request by protocol and identifier,
   * and optionally by lineage: the recorded span's parent name matches the current
   * active OpenTelemetry span's name (semantic tree matching).
   * Custom matchers are evaluated first; if any returns MOCK, that payload is returned; if any returns PASSTHROUGH, throws.
   */
  findMatch(request: MatchRequest): unknown {
    for (const matcher of this.customMatchers) {
      const result = matcher(request, this.recordedSpans);
      if (result.action === 'MOCK') return result.payload;
      if (result.action === 'PASSTHROUGH') {
        throw new Error('[Softprobe] Network Passthrough not allowed in strict mode');
      }
    }

    const candidates = this.recordedSpans.filter(
      (span) =>
        span.attributes[PROTOCOL_KEY] === request.protocol &&
        span.attributes[IDENTIFIER_KEY] === request.identifier
    );

    if (candidates.length === 0) {
      throw new Error(
        `[Softprobe] No recorded traces found for ${request.protocol}: ${request.identifier}`
      );
    }

    const liveSpan = trace.getActiveSpan();
    const liveParentName =
      liveSpan && typeof (liveSpan as unknown as { name?: string }).name === 'string'
        ? (liveSpan as unknown as { name: string }).name
        : 'root';

    const lineageMatches = candidates.filter((candidate) => {
      const parentSpanId = candidate.parentSpanId;
      if (parentSpanId == null) return liveParentName === 'root';
      const candidateParent = this.recordedSpans.find(
        (s) => s.spanContext().spanId === parentSpanId
      );
      return candidateParent != null && candidateParent.name === liveParentName;
    });

    let matched: ReadableSpan;
    if (lineageMatches.length > 0) {
      const sequenceKey = `${request.protocol}-${request.identifier}-${liveParentName}`;
      const currentCount = this.callSequenceMap.get(sequenceKey) ?? 0;
      // Wrap-around: if call count exceeds number of lineage matches, reuse the first match
      matched = lineageMatches[currentCount] ?? lineageMatches[0];
      this.callSequenceMap.set(sequenceKey, currentCount + 1);
    } else {
      // Flat match: no lineage context, so we do not update callSequenceMap; always return first candidate.
      matched = candidates[0];
    }

    const raw = matched.attributes[RESPONSE_BODY_KEY];
    if (typeof raw !== 'string') {
      throw new Error('[Softprobe] Missing or invalid softprobe.response.body on matched span');
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('[Softprobe] Invalid or non-JSON softprobe.response.body on matched span');
    }
  }
}
