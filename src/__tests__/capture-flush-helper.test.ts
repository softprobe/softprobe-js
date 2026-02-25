import * as otelApi from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { SoftprobeContext } from '../context';
import { flushCaptureFromContext } from '../core/cassette/context-capture';
import type { Cassette } from '../types/schema';

describe('flushCaptureFromContext', () => {
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

  it('calls cassette.flush when available', async () => {
    const flush = jest.fn(async () => {});
    const cassette: Cassette = {
      loadTrace: async () => [],
      saveRecord: async () => {},
      flush,
    };

    await SoftprobeContext.run(
      { mode: 'CAPTURE', traceId: 'trace-flush-helper', storage: cassette },
      async () => {
        await flushCaptureFromContext();
      }
    );

    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('no-ops safely when cassette.flush is undefined', async () => {
    const cassette: Cassette = {
      loadTrace: async () => [],
      saveRecord: async () => {},
    };

    await expect(
      SoftprobeContext.run(
        { mode: 'CAPTURE', traceId: 'trace-no-flush', storage: cassette },
        async () => {
          await flushCaptureFromContext();
        }
      )
    ).resolves.toBeUndefined();
  });
});
