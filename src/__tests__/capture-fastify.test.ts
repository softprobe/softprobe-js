/**
 * Task 14.2.1: Fastify plugin capture path.
 * Task 14.2.2: Fastify preHandler for replay initialization.
 * Task 17.3.2: Middleware sets OTel context; downstream code can retrieve via getSoftprobeContext().
 */

import Fastify from 'fastify';
import fp from 'fastify-plugin';
import * as otelApi from '@opentelemetry/api';
import { trace } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import type { CassetteStore } from '../store/cassette-store';
import { setCaptureStore } from '../capture/store-accessor';
import { CaptureEngine } from '../capture/express';
import { softprobeFastifyPlugin } from '../capture/fastify';
import { softprobe } from '../api';
import { getSoftprobeContext, initGlobalContext } from '../context';

describe('softprobeFastifyPlugin capture path (Task 14.2.1)', () => {
  afterEach(async () => {
    setCaptureStore(undefined);
    jest.restoreAllMocks();
  });

  it('onSend captures full payload and writes inbound record to side-channel', async () => {
    initGlobalContext({ mode: 'CAPTURE' });
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
  afterEach(async () => {
    jest.restoreAllMocks();
  });

  it('preHandler primes SoftprobeMatcher with records matching the active OTel traceId', async () => {
    initGlobalContext({ mode: 'REPLAY' });
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

describe('Task 17.3.2: Fastify plugin sets OTel context for downstream getSoftprobeContext()', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('route handler sees softprobe context set by plugin via getSoftprobeContext()', async () => {
    initGlobalContext({ mode: 'REPLAY', cassettePath: '/fastify-cassettes.ndjson' });
    const traceId = 'trace-fastify-ctx-1';
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId, spanId: 'span-f-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    const app = Fastify();
    await app.register(fp(softprobeFastifyPlugin));
    app.get('/ctx', async () => getSoftprobeContext());

    const res = await app.inject({ method: 'GET', url: '/ctx' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.traceId).toBe(traceId);
    expect(body.mode).toBe('REPLAY');
    expect(body.cassettePath).toBe('/fastify-cassettes.ndjson');
  });
});

describe('Task 21.1.1: Header extraction in Fastify — getSoftprobeContext() returns header values over YAML defaults', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('request with coordination headers: getSoftprobeContext() returns header values, not YAML defaults', async () => {
    initGlobalContext({ mode: 'PASSTHROUGH', cassettePath: '/yaml-default.ndjson' });
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId: 'otel-span-trace', spanId: 'span-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    const app = Fastify();
    await app.register(fp(softprobeFastifyPlugin));
    app.get('/ctx', async () => getSoftprobeContext());

    const res = await app.inject({
      method: 'GET',
      url: '/ctx',
      headers: {
        'x-softprobe-mode': 'REPLAY',
        'x-softprobe-trace-id': 'header-trace-99',
        'x-softprobe-cassette-path': '/header-cassette.ndjson',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.mode).toBe('REPLAY');
    expect(body.traceId).toBe('header-trace-99');
    expect(body.cassettePath).toBe('/header-cassette.ndjson');
  });
});
