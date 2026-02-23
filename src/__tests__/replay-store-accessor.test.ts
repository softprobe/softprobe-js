/**
 * Task 15.3.1: Middleware loads specific trace records from eager-loaded global store.
 * Test: middleware retrieves only records for the current traceId from the store initialized at boot.
 */
import { softprobe } from '../api';
import type { SoftprobeCassetteRecord } from '../types/schema';

function record(traceId: string, spanId: string, identifier: string): SoftprobeCassetteRecord {
  return {
    version: '4.1',
    traceId,
    spanId,
    timestamp: '2025-01-01T00:00:00.000Z',
    type: 'outbound',
    protocol: 'http',
    identifier,
  };
}

describe('Task 15.3.1: replay store accessor', () => {
  it('middleware retrieves only records for the current traceId from the store initialized at boot', () => {
    const traceA = 'trace-aaa';
    const traceB = 'trace-bbb';
    const store: SoftprobeCassetteRecord[] = [
      record(traceA, 'span-a1', 'GET /a'),
      record(traceA, 'span-a2', 'GET /b'),
      record(traceB, 'span-b1', 'GET /c'),
    ];
    softprobe.setReplayRecordsCache(store);

    const forA = softprobe.getRecordsForTrace(traceA);
    const forB = softprobe.getRecordsForTrace(traceB);

    expect(forA).toHaveLength(2);
    expect(forA.every((r) => r.traceId === traceA)).toBe(true);
    expect(forA.map((r) => r.identifier)).toEqual(['GET /a', 'GET /b']);

    expect(forB).toHaveLength(1);
    expect(forB[0].traceId).toBe(traceB);
    expect(forB[0].identifier).toBe('GET /c');
  });

  it('getRecordsForTrace matches traceId case-insensitively (W3C traceparent)', () => {
    const store: SoftprobeCassetteRecord[] = [
      record('Trace-Id-Mixed', 'span-1', 'GET /'),
    ];
    softprobe.setReplayRecordsCache(store);

    const found = softprobe.getRecordsForTrace('trace-id-mixed');
    expect(found).toHaveLength(1);
    expect(found[0].traceId).toBe('Trace-Id-Mixed');
  });
});
