/**
 * Task 3.1: AsyncLocalStorage Trace Isolation.
 * Task 8.1.1: ALS store shape { traceId?, cassettePath }.
 * Task 8.2.1: runWithContext loads records once and sets into matcher.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { softprobe } from '../api';
import type { SoftprobeMatcher } from '../replay/softprobe-matcher';

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

  /**
   * Task 8.1.1: runWithContext sets ALS store { traceId?, cassettePath } visible inside callback.
   */
  it('runWithContext sets ALS store visible inside callback (traceId and cassettePath)', async () => {
    const traceId = 'prod-trace-345';
    const tmpPath = path.join(os.tmpdir(), `softprobe-als-store-${Date.now()}.ndjson`);
    fs.writeFileSync(
      tmpPath,
      '{"version":"4.1","traceId":"' + traceId + '","spanId":"s1","timestamp":"2025-01-01T00:00:00.000Z","type":"outbound","protocol":"http","identifier":"GET /"}\n',
      'utf8'
    );

    const storeInside = await softprobe.runWithContext(
      { traceId, cassettePath: tmpPath },
      async () => softprobe.getReplayContext()
    );

    expect(storeInside).toBeDefined();
    expect(storeInside?.traceId).toBe(traceId);
    expect(storeInside?.cassettePath).toBe(tmpPath);

    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup
    }
  });

  /**
   * Task 8.2.1: runWithContext loads records once and sets into matcher; matcher fn sees records length > 0.
   */
  it('runWithContext loads records and sets into matcher so matcher fn sees records', async () => {
    const tmpPath = path.join(os.tmpdir(), `softprobe-runWithContext-${Date.now()}.ndjson`);
    const oneRecord =
      '{"version":"4.1","traceId":"t1","spanId":"s1","timestamp":"2025-01-01T00:00:00.000Z","type":"outbound","protocol":"postgres","identifier":"SELECT 1"}\n';
    fs.writeFileSync(tmpPath, oneRecord, 'utf8');

    let recordsLength = 0;
    await softprobe.runWithContext({ cassettePath: tmpPath }, async () => {
      const matcher = softprobe.getActiveMatcher() as SoftprobeMatcher | undefined;
      expect(matcher).toBeDefined();
      (matcher as SoftprobeMatcher).use((_span, records) => {
        recordsLength = records.length;
        return { action: 'CONTINUE' };
      });
      (matcher as SoftprobeMatcher).match();
    });

    expect(recordsLength).toBeGreaterThan(0);

    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup
    }
  });
});
