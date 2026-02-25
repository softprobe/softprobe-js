import { SoftprobeContext } from '../context';
import type { Cassette } from '../types/schema';

describe('SoftprobeContext.run signature', () => {
  const cassette: Cassette = {
    loadTrace: async () => [],
    saveRecord: async () => {},
  };

  it('requires SoftprobeRunOptions fields', async () => {
    await SoftprobeContext.run(
      { mode: 'CAPTURE', storage: cassette, traceId: 'trace-1' },
      async () => {}
    );

    // @ts-expect-error missing storage
    await SoftprobeContext.run({ mode: 'CAPTURE', traceId: 'trace-1' }, async () => {});

    // @ts-expect-error missing traceId
    await SoftprobeContext.run({ mode: 'REPLAY', storage: cassette }, async () => {});

    // @ts-expect-error missing mode
    await SoftprobeContext.run({ storage: cassette, traceId: 'trace-1' }, async () => {});
  });
});
