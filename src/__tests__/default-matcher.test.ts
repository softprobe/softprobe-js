/**
 * Task 4.4.1–4.4.2: createDefaultMatcher returns MatcherFn; MOCK with responsePayload; empty candidates => CONTINUE.
 */
import { testSpan } from '../bindings/test-span';
import { PostgresSpan } from '../bindings/postgres-span';
import type { SoftprobeCassetteRecord } from '../types/schema';
import { createDefaultMatcher } from '../replay/extract-key';

function outboundRecord(
  protocol: 'postgres' | 'redis' | 'http',
  identifier: string,
  responsePayload: unknown
): SoftprobeCassetteRecord {
  return {
    version: '4.1',
    traceId: 't1',
    spanId: 's1',
    timestamp: new Date().toISOString(),
    type: 'outbound',
    protocol,
    identifier,
    responsePayload,
  };
}

describe('createDefaultMatcher', () => {
  it('returns MatcherFn that returns MOCK with responsePayload from picked record', () => {
    const fn = createDefaultMatcher();
    const span = testSpan();
    PostgresSpan.tagQuery('SELECT 1', undefined, span);
    const records: SoftprobeCassetteRecord[] = [
      outboundRecord('postgres', 'SELECT 1', { rows: [{ id: 1 }], rowCount: 1 }),
    ];

    const result = fn(span as any, records);

    expect(result.action).toBe('MOCK');
    expect((result as { payload: unknown }).payload).toEqual({
      rows: [{ id: 1 }],
      rowCount: 1,
    });
  });

  it('returns CONTINUE when no candidates match (empty candidates)', () => {
    const fn = createDefaultMatcher();
    const span = testSpan();
    PostgresSpan.tagQuery('SELECT 1', undefined, span);
    const records: SoftprobeCassetteRecord[] = []; // no outbound for SELECT 1

    const result = fn(span as any, records);

    expect(result.action).toBe('CONTINUE');
  });

  it('consumes repeated identical outbound candidates in deterministic order, then returns CONTINUE when exhausted', () => {
    const fn = createDefaultMatcher();
    const span = testSpan();
    PostgresSpan.tagQuery('SELECT repeat', undefined, span);
    const records: SoftprobeCassetteRecord[] = [
      outboundRecord('postgres', 'SELECT repeat', { seq: 1 }),
      outboundRecord('postgres', 'SELECT repeat', { seq: 2 }),
    ];

    const first = fn(span as any, records);
    const second = fn(span as any, records);
    const third = fn(span as any, records);

    expect(first).toEqual({ action: 'MOCK', payload: { seq: 1 }, traceId: 't1' });
    expect(second).toEqual({ action: 'MOCK', payload: { seq: 2 }, traceId: 't1' });
    expect(third).toEqual({ action: 'CONTINUE' });
  });
});
