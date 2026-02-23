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

  /** Runs matcher fns in order; returns first non-CONTINUE or CONTINUE if all continue. */
  match(): MatcherAction {
    const span = trace.getActiveSpan();
    for (const fn of this.fns) {
      const r = fn(span, this.records);
      if (r.action !== 'CONTINUE') return r;
    }
    return { action: 'CONTINUE' };
  }
}
