/**
 * Task 3.1: AsyncLocalStorage Trace Isolation.
 * Ensures concurrent tests using different traceIds do not share matcher state.
 */
import { softprobe } from '../api';

describe('softprobe API (AsyncLocalStorage trace isolation)', () => {
  it('runs two async functions concurrently with different traceId contexts and each retrieves only its context', async () => {
    const traceId1 = 'trace-aaa';
    const traceId2 = 'trace-bbb';

    const [result1, result2] = await Promise.all([
      softprobe.runWithContext({ traceId: traceId1 }, async () => {
        return softprobe.getReplayContext();
      }),
      softprobe.runWithContext({ traceId: traceId2 }, async () => {
        return softprobe.getReplayContext();
      }),
    ]);

    expect(result1).toEqual({ traceId: traceId1 });
    expect(result2).toEqual({ traceId: traceId2 });
  });
});
