/**
 * V4 SoftprobeMatcher tests (use, clear, _setRecords, match).
 * Task 2.2.1: use(fn) appends matcher fns; public check via match order.
 */
import { SoftprobeMatcher } from '../replay/softprobe-matcher';
import type { MatcherFn, SoftprobeCassetteRecord } from '../types/schema';

function cassetteRecord(identifier: string): SoftprobeCassetteRecord {
  return {
    version: '4.1',
    traceId: 't1',
    spanId: 's1',
    timestamp: '2025-01-01T00:00:00.000Z',
    type: 'outbound',
    protocol: 'http',
    identifier,
  };
}

describe('SoftprobeMatcher', () => {
  describe('use(fn)', () => {
    it('appends matcher fns and runs them in registration order', () => {
      const m = new SoftprobeMatcher();
      // First fn returns CONTINUE, second returns MOCK => match() returns MOCK (list length 2, order preserved)
      const fn1: MatcherFn = () => ({ action: 'CONTINUE' });
      const fn2: MatcherFn = () => ({ action: 'MOCK', payload: 'from-second' });
      m.use(fn1);
      m.use(fn2);
      m._setRecords([]);

      const result = m.match();

      expect(result.action).toBe('MOCK');
      expect((result as { payload: unknown }).payload).toBe('from-second');
    });
  });

  describe('clear()', () => {
    it('removes all matchers; match returns CONTINUE', () => {
      const m = new SoftprobeMatcher();
      m.use(() => ({ action: 'MOCK', payload: null }));
      m._setRecords([]);
      expect(m.match().action).toBe('MOCK');

      m.clear();
      const result = m.match();

      expect(result.action).toBe('CONTINUE');
    });
  });

  describe('_setRecords(records)', () => {
    it('passes the stored list to matcher fns when they run', () => {
      const m = new SoftprobeMatcher();
      const received: SoftprobeCassetteRecord[] = [];
      m.use((_span, records) => {
        received.length = 0;
        received.push(...records);
        return { action: 'MOCK', payload: records.length };
      });
      const list = [cassetteRecord('GET /a'), cassetteRecord('GET /b')];
      m._setRecords(list);

      m.match();

      expect(received).toHaveLength(2);
      expect(received[0].identifier).toBe('GET /a');
      expect(received[1].identifier).toBe('GET /b');
    });
  });

  describe('match()', () => {
    it('returns first non-CONTINUE (fn1 CONTINUE, fn2 MOCK => MOCK)', () => {
      const m = new SoftprobeMatcher();
      m.use(() => ({ action: 'CONTINUE' }));
      m.use(() => ({ action: 'MOCK', payload: 42 }));
      m._setRecords([]);

      const result = m.match();

      expect(result.action).toBe('MOCK');
      expect((result as { payload: unknown }).payload).toBe(42);
    });

    it('returns CONTINUE when all matchers return CONTINUE', () => {
      const m = new SoftprobeMatcher();
      m.use(() => ({ action: 'CONTINUE' }));
      m.use(() => ({ action: 'CONTINUE' }));
      m._setRecords([]);

      const result = m.match();

      expect(result.action).toBe('CONTINUE');
    });

    it('stops at first non-CONTINUE and does not call later matchers', () => {
      const m = new SoftprobeMatcher();
      const first = jest.fn(() => ({ action: 'CONTINUE' as const }));
      const second = jest.fn(() => ({ action: 'PASSTHROUGH' as const }));
      const third = jest.fn(() => ({ action: 'MOCK' as const, payload: 'late' }));
      m.use(first);
      m.use(second);
      m.use(third);
      m._setRecords([]);

      const result = m.match();

      expect(result.action).toBe('PASSTHROUGH');
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      expect(third).not.toHaveBeenCalled();
    });
  });
});
