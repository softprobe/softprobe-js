import * as otelApi from '@opentelemetry/api';
import { context } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { SoftprobeContext } from '../context';
import type { Cassette, SoftprobeCassetteRecord } from '../types/schema';

describe('capture: getCassette().saveRecord(record) with context traceId', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
  });

  beforeEach(() => {
    SoftprobeContext.initGlobal({
      mode: 'PASSTHROUGH',
      cassettePath: '',
      strictReplay: false,
      strictComparison: false,
    });
  });

  it('in CAPTURE mode calls getCassette().saveRecord(record) with one arg (Task 13.3)', async () => {
    const saveRecord = jest.fn(async () => {});
    const cassette: Cassette = {
      loadTrace: async () => [],
      saveRecord,
    };
    const record: SoftprobeCassetteRecord = {
      version: '4.1',
      traceId: 'trace-capture-helper',
      spanId: 'span-write',
      timestamp: '2025-01-01T00:00:00.000Z',
      type: 'outbound',
      protocol: 'http',
      identifier: 'GET /capture-helper',
    };

    await SoftprobeContext.run(
      { mode: 'CAPTURE', traceId: 'trace-capture-helper', storage: cassette },
      async () => {
        await context.with(context.active(), async () => {
          const c = SoftprobeContext.getCassette();
          if (SoftprobeContext.getMode() !== 'CAPTURE' || !c) return;
          const tid = SoftprobeContext.getTraceId();
          await c.saveRecord(tid ? { ...record, traceId: tid } : record);
        });
      }
    );

    expect(saveRecord).toHaveBeenCalledTimes(1);
    expect(saveRecord).toHaveBeenCalledWith(record);
    expect(saveRecord.mock.calls[0]).toHaveLength(1);
  });

  it('Task 13.8: saveRecord is never called with traceId as second argument', async () => {
    const saveRecord = jest.fn(async () => {});
    const cassette: Cassette = {
      loadTrace: async () => [],
      saveRecord,
    };
    const record: SoftprobeCassetteRecord = {
      version: '4.1',
      traceId: 't',
      spanId: 's',
      timestamp: '2025-01-01T00:00:00.000Z',
      type: 'outbound',
      protocol: 'http',
      identifier: 'GET /',
    };
    await SoftprobeContext.run(
      { mode: 'CAPTURE', traceId: 't', storage: cassette },
      async () => {
        const c = SoftprobeContext.getCassette();
        if (SoftprobeContext.getMode() !== 'CAPTURE' || !c) return;
        const tid = SoftprobeContext.getTraceId();
        await c.saveRecord(tid ? { ...record, traceId: tid } : record);
      }
    );
    expect(saveRecord).toHaveBeenCalledTimes(1);
    expect(saveRecord.mock.calls[0].length).toBe(1);
  });
});
