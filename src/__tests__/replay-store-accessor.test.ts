/**
 * Task 15.3.1: getRecordsForTrace returns context-scoped records only (from the matcher created by SoftprobeContext.run(REPLAY)).
 */
import * as otelApi from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { softprobe } from '../api';
import { SoftprobeContext } from '../context';
import type { Cassette, SoftprobeCassetteRecord } from '../types/schema';

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
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
  });

  beforeEach(() => {
    SoftprobeContext.initGlobal({ mode: 'PASSTHROUGH' });
  });

  it('getRecordsForTrace returns only records for the current traceId from context (run creates matcher)', async () => {
    const traceA = 'trace-aaa';
    const traceB = 'trace-bbb';
    const store: SoftprobeCassetteRecord[] = [
      record(traceA, 'span-a1', 'GET /a'),
      record(traceA, 'span-a2', 'GET /b'),
      record(traceB, 'span-b1', 'GET /c'),
    ];
    const cassette: Cassette = {
      loadTrace: async () => store,
      saveRecord: async () => {},
    };

    await SoftprobeContext.run(
      { mode: 'REPLAY', storage: cassette, traceId: traceA },
      () => {
        const forA = softprobe.getRecordsForTrace(traceA);
        expect(forA).toHaveLength(2);
        expect(forA.every((r) => r.traceId === traceA)).toBe(true);
        expect(forA.map((r) => r.identifier)).toEqual(['GET /a', 'GET /b']);
      }
    );

    await SoftprobeContext.run(
      { mode: 'REPLAY', storage: cassette, traceId: traceB },
      () => {
        const forB = softprobe.getRecordsForTrace(traceB);
        expect(forB).toHaveLength(1);
        expect(forB[0].traceId).toBe(traceB);
        expect(forB[0].identifier).toBe('GET /c');
      }
    );
  });

  it('getRecordsForTrace matches traceId case-insensitively (W3C traceparent)', async () => {
    const store: SoftprobeCassetteRecord[] = [
      record('Trace-Id-Mixed', 'span-1', 'GET /'),
    ];
    const cassette: Cassette = {
      loadTrace: async () => store,
      saveRecord: async () => {},
    };

    await SoftprobeContext.run(
      { mode: 'REPLAY', storage: cassette, traceId: 'Trace-Id-Mixed' },
      () => {
        const found = softprobe.getRecordsForTrace('trace-id-mixed');
        expect(found).toHaveLength(1);
        expect(found[0].traceId).toBe('Trace-Id-Mixed');
      }
    );
  });

  it('getRecordsForTrace returns [] when no active context matcher', () => {
    const found = softprobe.getRecordsForTrace('any-trace');
    expect(found).toEqual([]);
  });
});
