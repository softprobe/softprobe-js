/**
 * V4 matcher type tests (MatcherAction, MatcherFn).
 * Task 2.1.1: MatcherAction discriminated union; action narrows payload fields.
 * Task 2.1.2: MatcherFn(span, records) signature matches intended use.
 */
import type { MatcherAction, MatcherFn, SoftprobeCassetteRecord } from '../types/schema';

describe('MatcherAction (V4)', () => {
  /**
   * Helper that only compiles if narrowing works: payload is present when action is "MOCK".
   */
  function getMockPayload(a: MatcherAction): unknown {
    if (a.action === 'MOCK') return a.payload;
    return undefined;
  }

  it('narrows payload for MOCK', () => {
    const a: MatcherAction = { action: 'MOCK', payload: 42 };
    expect(getMockPayload(a)).toBe(42);
  });

  it('returns undefined for CONTINUE (no payload field)', () => {
    const a: MatcherAction = { action: 'CONTINUE' };
    expect(getMockPayload(a)).toBeUndefined();
  });

  it('returns undefined for PASSTHROUGH (no payload field)', () => {
    const a: MatcherAction = { action: 'PASSTHROUGH' };
    expect(getMockPayload(a)).toBeUndefined();
  });

  it('has exactly three action variants', () => {
    const mock: MatcherAction = { action: 'MOCK', payload: null };
    const pass: MatcherAction = { action: 'PASSTHROUGH' };
    const cont: MatcherAction = { action: 'CONTINUE' };
    expect(mock.action).toBe('MOCK');
    expect(pass.action).toBe('PASSTHROUGH');
    expect(cont.action).toBe('CONTINUE');
  });
});

describe('MatcherFn (V4)', () => {
  it('accepts (span, records) and returns MatcherAction', () => {
    const fn: MatcherFn = (_span, _records) => ({ action: 'CONTINUE' });
    const records: SoftprobeCassetteRecord[] = [];
    const result = fn(undefined, records);
    expect(result).toEqual({ action: 'CONTINUE' });
    expect(result.action).toBe('CONTINUE');
  });

  it('can receive undefined span and empty records', () => {
    const fn: MatcherFn = (span, records) => {
      expect(span).toBeUndefined();
      expect(records).toEqual([]);
      return { action: 'MOCK', payload: null };
    };
    const out = fn(undefined, []);
    expect(out.action).toBe('MOCK');
    expect((out as { payload: unknown }).payload).toBeNull();
  });
});
