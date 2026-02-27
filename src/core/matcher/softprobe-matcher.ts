/**
 * SoftprobeMatcher: per-context replay matcher for outbound calls.
 *
 * One instance is created per SoftprobeContext.run(REPLAY) and stored in the OTel context
 * for that request. It holds the cassette records for that trace and runs a list of MatcherFn
 * in order; match() returns the first non-CONTINUE action (MOCK or PASSTHROUGH).
 *
 * Design §7.1: use(fn) appends; matchers do not execute passthrough. Records are context-scoped
 * (loaded from the cassette for this run's traceId).
 */
import { trace } from '@opentelemetry/api';
import type { MatcherAction, MatcherFn, SoftprobeCassetteRecord } from '../../types/schema';

export class SoftprobeMatcher {
  /** Matcher functions run in registration order; first non-CONTINUE wins. */
  private fns: MatcherFn[] = [];
  /** Cassette records for this replay context (one trace). Set by SoftprobeContext.run(REPLAY). */
  private records: SoftprobeCassetteRecord[] = [];

  /** Appends a matcher function. Fns are run in registration order. */
  use(fn: MatcherFn): void {
    this.fns.push(fn);
  }

  /** Removes all registered matcher fns. */
  clear(): void {
    this.fns = [];
  }

  /**
   * Sets the cassette records for this context. Called by SoftprobeContext.run(REPLAY)
   * after loading from storage so each matcher fn receives them in match().
   */
  _setRecords(records: SoftprobeCassetteRecord[]): void {
    this.records = records;
  }

  /**
   * Returns the records for this replay context (context-scoped).
   * Used by getRecordsForTrace when the active context has a matcher, so HTTP replay
   * (MSW interceptor) reads from context instead of a global cache.
   */
  _getRecords(): SoftprobeCassetteRecord[] {
    return this.records;
  }

  /**
   * Returns the trace id for the current request (from first record).
   * Used when context/span do not propagate to fetch so the interceptor can identify the trace.
   */
  _getTraceId(): string | undefined {
    return this.records[0]?.traceId;
  }

  /**
   * Returns the inbound record's responsePayload.body, with .http extracted when present.
   * Used by HTTP replay (MSW interceptor) so the mock response body matches the recorded inbound and diff passes.
   */
  _getInboundHttpBody(): unknown {
    const inbound = this.records.find((r) => r.type === 'inbound');
    const payload = inbound?.responsePayload as { body?: unknown } | undefined;
    const body = payload?.body;
    if (body == null) return undefined;
    const parsed =
      typeof body === 'string'
        ? (() => {
            try {
              return JSON.parse(body);
            } catch {
              return undefined;
            }
          })()
        : body;
    return parsed && typeof parsed === 'object' && 'http' in parsed
      ? (parsed as { http: unknown }).http
      : undefined;
  }

  /**
   * Runs registered matcher fns in order against the current active span (or spanOverride).
   * Returns the first non-CONTINUE action (MOCK or PASSTHROUGH), or CONTINUE if all fns continue.
   * Each fn receives the span and this context's records (design §7.1).
   */
  match(spanOverride?: import('@opentelemetry/api').Span | { attributes?: Record<string, unknown> }): MatcherAction {
    const span = (trace.getActiveSpan() ?? spanOverride) as import('@opentelemetry/api').Span | undefined;
    for (const fn of this.fns) {
      const r = fn(span as import('@opentelemetry/api').Span, this.records);
      if (r.action !== 'CONTINUE') return r;
    }
    return { action: 'CONTINUE' };
  }
}
