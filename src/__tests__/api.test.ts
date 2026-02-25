/**
 * Task 3.1: AsyncLocalStorage Trace Isolation.
 * Task 8.1.1: ALS store shape { traceId?, cassettePath }.
 * Task 8.2.1: runWithContext loads records once and sets into matcher.
 * Task 8.2.2: runWithContext sets inbound record cache; getRecordedInboundResponse returns it.
 * Task 15.2.1: compareInbound retrieves recorded inbound and performs deep equality on status/body.
 * Task 17.3.1: runWithContext sets OTel context so context.active().getValue(SOFTPROBE_CONTEXT_KEY) matches traceId/mode.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as otelApi from '@opentelemetry/api';
import { context } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';

import { softprobe } from '../api';
import { SOFTPROBE_CONTEXT_KEY } from '../context';
import type { SoftprobeMatcher } from '../replay/softprobe-matcher';
import { runSoftprobeScope } from './helpers/run-softprobe-scope';

describe('softprobe API (AsyncLocalStorage trace isolation)', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
  });

  it('runs two async functions concurrently with different traceId contexts and each retrieves only its context', async () => {
    const traceId1 = 'trace-aaa';
    const traceId2 = 'trace-bbb';

    const [result1, result2] = await Promise.all([
      runSoftprobeScope({ traceId: traceId1 }, async () => {
        return softprobe.getReplayContext();
      }),
      runSoftprobeScope({ traceId: traceId2 }, async () => {
        return softprobe.getReplayContext();
      }),
    ]);

    expect(result1?.traceId).toBe(traceId1);
    expect(result2?.traceId).toBe(traceId2);
  });

  /**
   * Task 8.1.1: runWithContext sets OTel context { traceId?, cassettePath } visible inside callback.
   */
  it('runWithContext sets OTel context visible inside callback (traceId and cassettePath)', async () => {
    const traceId = 'prod-trace-345';
    const tmpPath = path.join(os.tmpdir(), `softprobe-als-store-${Date.now()}.ndjson`);
    fs.writeFileSync(
      tmpPath,
      '{"version":"4.1","traceId":"' + traceId + '","spanId":"s1","timestamp":"2025-01-01T00:00:00.000Z","type":"outbound","protocol":"http","identifier":"GET /"}\n',
      'utf8'
    );

    const storeInside = await runSoftprobeScope(
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
   * Task 17.3.1: Inside runWithContext callback, OTel context.active().getValue(SOFTPROBE_CONTEXT_KEY) matches provided traceId/mode.
   */
  it('runWithContext sets OTel context so active context has traceId and mode', async () => {
    const traceId = 'otel-trace-17';
    const cassettePath = '';
    const mode = 'REPLAY' as const;

    const valueInside = await runSoftprobeScope(
      { traceId, cassettePath, mode },
      async () => context.active().getValue(SOFTPROBE_CONTEXT_KEY)
    );

    expect(valueInside).toEqual(expect.objectContaining({
      traceId,
      cassettePath,
      mode,
      strictReplay: false,
      strictComparison: false,
    }));
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
    await runSoftprobeScope({ cassettePath: tmpPath }, async () => {
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

  /**
   * Task 8.2.2: runWithContext sets inbound record cache; getRecordedInboundResponse returns correct record.
   */
  it('getRecordedInboundResponse returns correct record when cassette has inbound record', async () => {
    const traceId = 'trace-inbound-1';
    const inboundRecord = {
      version: '4.1' as const,
      traceId,
      spanId: 'inbound-span-1',
      timestamp: '2025-01-01T00:00:00.000Z',
      type: 'inbound' as const,
      protocol: 'http' as const,
      identifier: 'GET /users/1',
      responsePayload: { status: 200, body: { id: 1, name: 'Alice' } },
    };
    const tmpPath = path.join(os.tmpdir(), `softprobe-inbound-${Date.now()}.ndjson`);
    fs.writeFileSync(tmpPath, JSON.stringify(inboundRecord) + '\n', 'utf8');

    let recorded: ReturnType<typeof softprobe.getRecordedInboundResponse>;
    await runSoftprobeScope({ traceId, cassettePath: tmpPath }, async () => {
      recorded = softprobe.getRecordedInboundResponse();
      return undefined;
    });

    expect(recorded!).toBeDefined();
    expect(recorded!.type).toBe('inbound');
    expect(recorded!.protocol).toBe('http');
    expect(recorded!.identifier).toBe('GET /users/1');
    expect(recorded!.responsePayload).toEqual({ status: 200, body: { id: 1, name: 'Alice' } });

    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup
    }
  });

  describe('Task 15.2.1: compareInbound', () => {
    it('retrieves recorded inbound record and performs deep equality check on status and body', async () => {
      const traceId = 'trace-compare-1';
      const inboundRecord = {
        version: '4.1' as const,
        traceId,
        spanId: 'span-1',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'inbound' as const,
        protocol: 'http' as const,
        identifier: 'GET /users/1',
        responsePayload: { status: 200, body: { id: 1, name: 'Alice' } },
      };
      const tmpPath = path.join(os.tmpdir(), `softprobe-compare-${Date.now()}.ndjson`);
      fs.writeFileSync(tmpPath, JSON.stringify(inboundRecord) + '\n', 'utf8');

      await runSoftprobeScope({ traceId, cassettePath: tmpPath }, async () => {
        softprobe.compareInbound({ status: 200, body: { id: 1, name: 'Alice' } });
      });

      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    });

    it('throws when status does not match recorded inbound', async () => {
      const traceId = 'trace-compare-status';
      const inboundRecord = {
        version: '4.1' as const,
        traceId,
        spanId: 'span-1',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'inbound' as const,
        protocol: 'http' as const,
        identifier: 'GET /',
        responsePayload: { status: 200, body: {} },
      };
      const tmpPath = path.join(os.tmpdir(), `softprobe-compare-status-${Date.now()}.ndjson`);
      fs.writeFileSync(tmpPath, JSON.stringify(inboundRecord) + '\n', 'utf8');

      await runSoftprobeScope({ traceId, cassettePath: tmpPath }, async () => {
        expect(() => {
          softprobe.compareInbound({ status: 404, body: {} });
        }).toThrow(/status/);
      });

      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    });

    it('throws when body does not match recorded inbound', async () => {
      const traceId = 'trace-compare-body';
      const inboundRecord = {
        version: '4.1' as const,
        traceId,
        spanId: 'span-1',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'inbound' as const,
        protocol: 'http' as const,
        identifier: 'GET /',
        responsePayload: { status: 200, body: { x: 1 } },
      };
      const tmpPath = path.join(os.tmpdir(), `softprobe-compare-body-${Date.now()}.ndjson`);
      fs.writeFileSync(tmpPath, JSON.stringify(inboundRecord) + '\n', 'utf8');

      await runSoftprobeScope({ traceId, cassettePath: tmpPath }, async () => {
        expect(() => {
          softprobe.compareInbound({ status: 200, body: { x: 2 } });
        }).toThrow(/body/);
      });

      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    });

    it('throws when no recorded inbound exists', async () => {
      const tmpPath = path.join(os.tmpdir(), `softprobe-compare-none-${Date.now()}.ndjson`);
      fs.writeFileSync(
        tmpPath,
        '{"version":"4.1","traceId":"t1","spanId":"s1","timestamp":"2025-01-01T00:00:00.000Z","type":"outbound","protocol":"http","identifier":"GET /"}\n',
        'utf8'
      );

      await runSoftprobeScope({ traceId: 't1', cassettePath: tmpPath }, async () => {
        expect(() => {
          softprobe.compareInbound({ status: 200, body: {} });
        }).toThrow(/no recorded inbound/);
      });

      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    });
  });

  describe('Task 15.2.2: SOFTPROBE_STRICT_COMPARISON', () => {
    const traceId = 'trace-strict-headers';
    const inboundWithHeaders = {
      version: '4.1' as const,
      traceId,
      spanId: 'span-1',
      timestamp: '2025-01-01T00:00:00.000Z',
      type: 'inbound' as const,
      protocol: 'http' as const,
      identifier: 'GET /',
      responsePayload: {
        status: 200,
        body: {},
        headers: { 'content-type': 'application/json', 'x-request-id': 'abc' },
      },
    };

    it('when strict, mismatched headers cause failure', async () => {
      const tmpPath = path.join(os.tmpdir(), `softprobe-strict-${Date.now()}.ndjson`);
      fs.writeFileSync(tmpPath, JSON.stringify(inboundWithHeaders) + '\n', 'utf8');
      try {
        await runSoftprobeScope(
          { traceId, cassettePath: tmpPath, strictComparison: true },
          async () => {
            expect(() => {
              softprobe.compareInbound({
                status: 200,
                body: {},
                headers: { 'content-type': 'application/json', 'x-request-id': 'different' },
              });
            }).toThrow(/header/);
          }
        );
      } finally {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore
        }
      }
    });

    it('when strict, matching headers do not cause failure', async () => {
      const tmpPath = path.join(os.tmpdir(), `softprobe-strict-ok-${Date.now()}.ndjson`);
      fs.writeFileSync(tmpPath, JSON.stringify(inboundWithHeaders) + '\n', 'utf8');
      try {
        await runSoftprobeScope(
          { traceId, cassettePath: tmpPath, strictComparison: true },
          async () => {
            softprobe.compareInbound({
              status: 200,
              body: {},
              headers: { 'content-type': 'application/json', 'x-request-id': 'abc' },
            });
          }
        );
      } finally {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore
        }
      }
    });

    it('when off, only status and body matter (mismatched headers do not cause failure)', async () => {
      const tmpPath = path.join(os.tmpdir(), `softprobe-nostrict-${Date.now()}.ndjson`);
      fs.writeFileSync(tmpPath, JSON.stringify(inboundWithHeaders) + '\n', 'utf8');
      try {
        await runSoftprobeScope(
          { traceId, cassettePath: tmpPath, strictComparison: false },
          async () => {
            softprobe.compareInbound({
              status: 200,
              body: {},
              headers: { 'content-type': 'text/plain', 'x-other': 'ignored' },
            });
          }
        );
      } finally {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore
        }
      }
    });
  });

  it('Task 2.8: runWithContext cleanup preserves legacy fields and seeds replay matcher/inbound before callback', async () => {
    const traceId = 'trace-cleanup-28';
    const cassettePath = path.join(os.tmpdir(), `softprobe-cleanup-28-${Date.now()}.ndjson`);
    const inboundRecord = {
      version: '4.1' as const,
      traceId,
      spanId: 'inbound-1',
      timestamp: '2025-01-01T00:00:00.000Z',
      type: 'inbound' as const,
      protocol: 'http' as const,
      identifier: 'GET /cleanup',
      responsePayload: { status: 200, body: { ok: true } },
    };
    const outboundRecord =
      '{"version":"4.1","traceId":"' +
      traceId +
      '","spanId":"out-1","timestamp":"2025-01-01T00:00:01.000Z","type":"outbound","protocol":"http","identifier":"GET /users","responsePayload":{"value":1}}\n';
    fs.writeFileSync(cassettePath, JSON.stringify(inboundRecord) + '\n' + outboundRecord, 'utf8');

    let seenCassettePath = '';
    let seenStrictReplay = false;
    let seenStrictComparison = false;
    let seenRecordCount = 0;
    let seenInboundType = '';

    await runSoftprobeScope(
      { traceId, cassettePath, strictReplay: true, strictComparison: true, mode: 'REPLAY' },
      async () => {
        const replayCtx = softprobe.getReplayContext();
        seenCassettePath = replayCtx?.cassettePath ?? '';
        seenStrictReplay = replayCtx?.strictReplay ?? false;
        seenStrictComparison = replayCtx?.strictComparison ?? false;

        const matcher = softprobe.getActiveMatcher() as SoftprobeMatcher | undefined;
        expect(matcher).toBeDefined();
        (matcher as SoftprobeMatcher).use((_span, records) => {
          seenRecordCount = records.length;
          return { action: 'CONTINUE' };
        });
        (matcher as SoftprobeMatcher).match();

        seenInboundType = softprobe.getRecordedInboundResponse()?.type ?? '';
      }
    );

    expect(seenCassettePath).toBe(cassettePath);
    expect(seenStrictReplay).toBe(true);
    expect(seenStrictComparison).toBe(true);
    expect(seenRecordCount).toBeGreaterThan(0);
    expect(seenInboundType).toBe('inbound');

    try {
      fs.unlinkSync(cassettePath);
    } catch {
      // ignore cleanup
    }
  });
});
