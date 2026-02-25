/**
 * V4 SoftprobeMatcher: list of MatcherFn; match() returns first non-CONTINUE.
 * Design §7.1: use(fn) appends; matchers do not execute passthrough.
 */
import { trace } from '@opentelemetry/api';
import type { MatcherAction, MatcherFn, SoftprobeCassetteRecord } from '../types/schema';

export class SoftprobeMatcher {
  private fns: MatcherFn[] = [];
  private records: SoftprobeCassetteRecord[] = [];

  /** Appends a matcher function. Fns are run in registration order. */
  use(fn: MatcherFn): void {
    this.fns.push(fn);
  }

  /** Removes all registered matcher fns. */
  clear(): void {
    this.fns = [];
  }

  /** Sets the cassette records passed to each matcher fn. */
  _setRecords(records: SoftprobeCassetteRecord[]): void {
    this.records = records;
  }

  /** Returns the trace id for the current request (from first record). Used when context/span do not propagate to fetch. */
  _getTraceId(): string | undefined {
    return this.records[0]?.traceId;
  }

  /**
   * Returns the inbound record's responsePayload.body parsed and .http section, if present.
   * Used by undici replay so the mock response body matches the recorded inbound (diff passes).
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
   * Runs matcher fns in order; returns first non-CONTINUE or CONTINUE if all continue.
   * When spanOverride is provided (e.g. when there is no active OTel span), it is passed
   * to matcher fns so extractKeyFromSpan can read .attributes; design §7.1.
   */
  match(spanOverride?: { attributes?: Record<string, unknown> }): MatcherAction {
    const span = spanOverride ?? trace.getActiveSpan();
    for (const fn of this.fns) {
      const r = fn(span as import('@opentelemetry/api').Span, this.records);
      if (r.action !== 'CONTINUE') return r;
    }
    return { action: 'CONTINUE' };
  }
}
