/**
 * Task 14.2.1: Fastify plugin capture path.
 * Task 14.2.2: Fastify preHandler for replay initialization.
 * Task 17.3.2: Middleware sets OTel context; downstream code can retrieve via SoftprobeContext.active().
 */

import Fastify from 'fastify';
import fp from 'fastify-plugin';
import * as otelApi from '@opentelemetry/api';
import { trace } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Cassette } from '../types/schema';
import { CaptureEngine } from '../capture/express';
import { softprobeFastifyPlugin } from '../capture/fastify';
import { softprobe } from '../api';
import { SoftprobeContext } from '../context';

const replayCassette: Cassette = {
  loadTrace: async () => [],
  saveRecord: async () => {},
};

describe('softprobeFastifyPlugin capture path (Task 14.2.1)', () => {
  afterEach(async () => {
    jest.restoreAllMocks();
  });

  it('onSend captures full payload and writes inbound record to side-channel', async () => {
    const saveRecord = jest.fn<ReturnType<Cassette['saveRecord']>, Parameters<Cassette['saveRecord']>>(async () => {});
    const cassette: Cassette = {
      loadTrace: async () => [],
      saveRecord,
    };
    SoftprobeContext.initGlobal({ mode: 'CAPTURE', storage: cassette });
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId: 'trace-fastify-1', spanId: 'span-fastify-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    const app = Fastify();
    await app.register(fp(softprobeFastifyPlugin));
    app.get('/ping', async () => ({ pong: true, count: 42 }));

    const queueSpy = jest.spyOn(CaptureEngine, 'queueInboundResponse');
    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { 'x-softprobe-cassette-path': '/capture-fastify-task-14-2-1.ndjson' },
    });

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
    const record = saveRecord.mock.calls[0][1];
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
    SoftprobeContext.initGlobal({ mode: 'REPLAY', storage: replayCassette });
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

describe('Task 17.3.2: Fastify plugin sets OTel context for downstream SoftprobeContext.active()', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('route handler sees softprobe context set by plugin via SoftprobeContext.active()', async () => {
    SoftprobeContext.initGlobal({ mode: 'REPLAY', storage: replayCassette });
    const traceId = 'trace-fastify-ctx-1';
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId, spanId: 'span-f-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    const app = Fastify();
    await app.register(fp(softprobeFastifyPlugin));
    app.get('/ctx', async () => SoftprobeContext.active());

    const res = await app.inject({ method: 'GET', url: '/ctx' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.traceId).toBe(traceId);
    expect(body.mode).toBe('REPLAY');
    expect(body.storage).toBeDefined();
  });
});

describe('Task 21.1.1: Header extraction in Fastify — SoftprobeContext.active() returns header values over YAML defaults', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('request with coordination headers: SoftprobeContext.active() returns header values, not YAML defaults', async () => {
    SoftprobeContext.initGlobal({ mode: 'PASSTHROUGH', storage: replayCassette });
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId: 'otel-span-trace', spanId: 'span-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);
    jest.spyOn(softprobe, 'ensureReplayLoadedForRequest').mockResolvedValue(undefined);

    const app = Fastify();
    await app.register(fp(softprobeFastifyPlugin));
    app.get('/ctx', async () => SoftprobeContext.active());

    const cassettePath = path.join(os.tmpdir(), `softprobe-header-fastify-${Date.now()}.ndjson`);
    fs.writeFileSync(cassettePath, '', 'utf8');
    const res = await app.inject({
      method: 'GET',
      url: '/ctx',
      headers: {
        'x-softprobe-mode': 'REPLAY',
        'x-softprobe-trace-id': 'header-trace-99',
        'x-softprobe-cassette-path': cassettePath,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.mode).toBe('REPLAY');
    expect(body.traceId).toBe('header-trace-99');
    expect(body.storage).toBeDefined();
    fs.unlinkSync(cassettePath);
  });
});

describe('Task 5.2: Fastify plugin uses SoftprobeContext.run(options, handler)', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('route handler observes active mode, traceId, and storage', async () => {
    SoftprobeContext.initGlobal({ mode: 'CAPTURE', cassettePath: '/fastify-task-5-2.ndjson' });
    const traceId = 'trace-fastify-task-5-2';
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId, spanId: 'span-fastify-task-5-2' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    const app = Fastify();
    await app.register(fp(softprobeFastifyPlugin));
    app.get('/task-5-2', async () => ({
      mode: SoftprobeContext.getMode(),
      traceId: SoftprobeContext.getTraceId(),
      hasStorage: SoftprobeContext.getCassette() != null,
    }));

    const res = await app.inject({
      method: 'GET',
      url: '/task-5-2',
      headers: { 'x-softprobe-cassette-path': '/capture-fastify-task-5-2.ndjson' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.mode).toBe('CAPTURE');
    expect(body.traceId).toBe(traceId);
    expect(body.hasStorage).toBe(true);
  });
});

describe('Task 5.4: Header coordination overrides defaults via run options in Fastify', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('array coordination headers override default mode and span trace id in active context', async () => {
    SoftprobeContext.initGlobal({ mode: 'PASSTHROUGH', storage: replayCassette });
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId: 'span-trace-fastify-5-4', spanId: 'span-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);
    jest.spyOn(softprobe, 'ensureReplayLoadedForRequest').mockResolvedValue(undefined);

    const app = Fastify();
    await app.register(fp(softprobeFastifyPlugin));
    app.get('/task-5-4-fastify', async () => SoftprobeContext.active());

    const res = await app.inject({
      method: 'GET',
      url: '/task-5-4-fastify',
      headers: {
        'x-softprobe-mode': ['REPLAY'],
        'x-softprobe-trace-id': ['header-trace-fastify-5-4'],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.mode).toBe('REPLAY');
    expect(body.traceId).toBe('header-trace-fastify-5-4');
  });
});
