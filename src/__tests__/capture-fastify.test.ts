/**
 * Task 14.2.1: Fastify plugin capture path.
 * Task 14.2.2: Fastify preHandler for replay initialization.
 */

import Fastify from 'fastify';
import fp from 'fastify-plugin';
import { trace } from '@opentelemetry/api';
import type { CassetteStore } from '../store/cassette-store';
import { setCaptureStore } from '../capture/store-accessor';
import { CaptureEngine } from '../capture/express';
import { softprobeFastifyPlugin } from '../capture/fastify';
import { softprobe } from '../api';

describe('softprobeFastifyPlugin capture path (Task 14.2.1)', () => {
  const originalEnv = process.env.SOFTPROBE_MODE;

  afterEach(async () => {
    process.env.SOFTPROBE_MODE = originalEnv;
    setCaptureStore(undefined);
    jest.restoreAllMocks();
  });

  it('onSend captures full payload and writes inbound record to side-channel', async () => {
    process.env.SOFTPROBE_MODE = 'CAPTURE';
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId: 'trace-fastify-1', spanId: 'span-fastify-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    const saveRecord = jest.fn<void, [Parameters<CassetteStore['saveRecord']>[0]]>();
    const mockStore = { saveRecord } as unknown as CassetteStore;
    setCaptureStore(mockStore);

    const app = Fastify();
    await app.register(fp(softprobeFastifyPlugin));
    app.get('/ping', async () => ({ pong: true, count: 42 }));

    const queueSpy = jest.spyOn(CaptureEngine, 'queueInboundResponse');
    const res = await app.inject({ method: 'GET', url: '/ping' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ pong: true, count: 42 });
    expect(queueSpy).toHaveBeenCalledTimes(1);
    expect(queueSpy).toHaveBeenCalledWith(
      'trace-fastify-1',
      expect.objectContaining({
        status: 200,
        body: expect.anything(),
        identifier: 'GET /ping',
      })
    );
    expect(saveRecord).toHaveBeenCalledTimes(1);
    const record = saveRecord.mock.calls[0][0];
    expect(record.type).toBe('inbound');
    expect(record.protocol).toBe('http');
    expect(record.traceId).toBe('trace-fastify-1');
    expect(record.responsePayload).toEqual(
      expect.objectContaining({
        statusCode: 200,
        body: '{"pong":true,"count":42}', // Fastify onSend receives serialized payload
      })
    );
  });
});

describe('softprobeFastifyPlugin replay preHandler (Task 14.2.2)', () => {
  const originalEnv = process.env.SOFTPROBE_MODE;

  afterEach(async () => {
    process.env.SOFTPROBE_MODE = originalEnv;
    jest.restoreAllMocks();
  });

  it('preHandler primes SoftprobeMatcher with records matching the active OTel traceId', async () => {
    process.env.SOFTPROBE_MODE = 'REPLAY';
    const traceId = 'trace-fastify-replay-1';
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId, spanId: 'span-fastify-replay-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    const activateSpy = jest.spyOn(softprobe, 'activateReplayForContext');

    const app = Fastify();
    await app.register(fp(softprobeFastifyPlugin));
    app.get('/replay-test', async () => ({ ok: true }));

    await app.inject({ method: 'GET', url: '/replay-test' });

    expect(activateSpy).toHaveBeenCalledTimes(1);
    expect(activateSpy).toHaveBeenCalledWith(traceId);
  });
});
