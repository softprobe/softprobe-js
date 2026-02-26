import { softprobe } from '../api';
import type { Cassette } from '../types/schema';

describe('softprobe API surface', () => {
  const cassette: Cassette = {
    loadTrace: async () => [],
    saveRecord: async () => {},
  };

  it('does not expose legacy runWithContext', () => {
    // @ts-expect-error runWithContext has been removed from public API
    softprobe.runWithContext;
  });

  it('does not expose legacy getReplayContext', () => {
    // @ts-expect-error getReplayContext has been replaced by getContext
    softprobe.getReplayContext;
  });

  it('exposes run with SoftprobeRunOptions (storage, not cassettePath)', async () => {
    await softprobe.run(
      { mode: 'CAPTURE', storage: cassette, traceId: 'trace-1' },
      async () => {}
    );

    // @ts-expect-error legacy cassettePath option is not supported
    await softprobe.run({ mode: 'CAPTURE', cassettePath: '/tmp/a.ndjson', traceId: 'trace-1' }, async () => {});
  });
});
