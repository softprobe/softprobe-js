/**
 * Task 14.1.1 / 14.1.2: Express middleware capture and replay paths.
 * Task 14.3.1: Inbound request record contains parsed JSON body when middleware is after body-parser.
 * Task 17.3.2: Middleware sets OTel context; downstream code can retrieve via SoftprobeContext.active().
 */

import * as otelApi from '@opentelemetry/api';
import { trace } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Cassette } from '../types/schema';
import { CaptureEngine, softprobeExpressMiddleware } from '../instrumentations/express/capture';
import { softprobe } from '../api';
import { SoftprobeContext } from '../context';

beforeAll(() => {
  const contextManager = new AsyncHooksContextManager();
  contextManager.enable();
  otelApi.context.setGlobalContextManager(contextManager);
});

const replayCassette: Cassette = {
  loadTrace: async () => [],
  saveRecord: async () => {},
};

describe('softprobeExpressMiddleware capture path (Task 14.1.1)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('when mode=CAPTURE, res.send triggers CaptureEngine.queueInboundResponse with status and body', () => {
    const cassetteDir = path.join(os.tmpdir(), `softprobe-capture-express-${Date.now()}`);
    fs.mkdirSync(cassetteDir, { recursive: true });
    SoftprobeContext.initGlobal({ mode: 'CAPTURE', cassetteDirectory: cassetteDir });
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId: 'trace-express-1', spanId: 'span-express-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    const queueSpy = jest.spyOn(CaptureEngine, 'queueInboundResponse');
    const originalSend = jest.fn();
    const req = {
      method: 'GET',
      path: '/users/1',
      headers: {},
    };
    const res = { statusCode: 200, send: originalSend };
    const next = jest.fn();

    softprobeExpressMiddleware(req as any, res as any, next as any);
    expect(next).toHaveBeenCalledTimes(1);

    res.send({ id: 1, name: 'alice' });

    expect(queueSpy).toHaveBeenCalledTimes(1);
    expect(queueSpy).toHaveBeenCalledWith(
      'trace-express-1',
      expect.objectContaining({
        status: 200,
        body: { id: 1, name: 'alice' },
        identifier: 'GET /users/1',
      }),
      expect.objectContaining({
        mode: 'CAPTURE',
        traceId: 'trace-express-1',
      })
    );
    expect(originalSend).toHaveBeenCalledWith({ id: 1, name: 'alice' });
  });

  it('captures mounted router request path using originalUrl, not req.path slash root', () => {
    const cassetteDir = path.join(os.tmpdir(), `softprobe-capture-express-mounted-${Date.now()}`);
    fs.mkdirSync(cassetteDir, { recursive: true });
    SoftprobeContext.initGlobal({ mode: 'CAPTURE', cassetteDirectory: cassetteDir });
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId: 'trace-express-mounted-1', spanId: 'span-express-mounted-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    const queueSpy = jest.spyOn(CaptureEngine, 'queueInboundResponse');
    const originalSend = jest.fn();
    const req = {
      method: 'GET',
      path: '/',
      originalUrl: '/products',
      headers: {},
    };
    const res = { statusCode: 200, send: originalSend };
    const next = jest.fn();

    softprobeExpressMiddleware(req as any, res as any, next as any);
    res.send({ ok: true });

    expect(queueSpy).toHaveBeenCalledWith(
      'trace-express-mounted-1',
      expect.objectContaining({
        identifier: 'GET /products',
      }),
      expect.objectContaining({
        mode: 'CAPTURE',
        traceId: 'trace-express-mounted-1',
      })
    );
  });

  it('captures mounted router request path including query parameters from originalUrl', () => {
    const cassetteDir = path.join(os.tmpdir(), `softprobe-capture-express-mounted-query-${Date.now()}`);
    fs.mkdirSync(cassetteDir, { recursive: true });
    SoftprobeContext.initGlobal({ mode: 'CAPTURE', cassetteDirectory: cassetteDir });
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId: 'trace-express-mounted-query-1', spanId: 'span-express-mounted-query-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    const queueSpy = jest.spyOn(CaptureEngine, 'queueInboundResponse');
    const originalSend = jest.fn();
    const req = {
      method: 'GET',
      path: '/',
      originalUrl: '/products?page=2',
      headers: {},
    };
    const res = { statusCode: 200, send: originalSend };
    const next = jest.fn();

    softprobeExpressMiddleware(req as any, res as any, next as any);
    res.send({ ok: true });

    expect(queueSpy).toHaveBeenCalledWith(
      'trace-express-mounted-query-1',
      expect.objectContaining({
        identifier: 'GET /products?page=2',
      }),
      expect.objectContaining({
        mode: 'CAPTURE',
        traceId: 'trace-express-mounted-query-1',
      })
    );
  });

  it('captures inbound response when res.send runs after an async boundary with cassetteDirectory-only config', async () => {
    const cassetteDir = path.join(os.tmpdir(), `softprobe-capture-express-async-${Date.now()}`);
    fs.mkdirSync(cassetteDir, { recursive: true });
    SoftprobeContext.initGlobal({ mode: 'CAPTURE', cassetteDirectory: cassetteDir });
    const traceId = 'trace-express-async-boundary-1';
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId, spanId: 'span-express-async-boundary-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    const req = {
      method: 'GET',
      path: '/async-users/1',
      headers: {},
    };
    const res = { statusCode: 200, send: jest.fn() };
    const next = jest.fn();

    softprobeExpressMiddleware(req as any, res as any, next as any);
    await Promise.resolve();
    res.send({ id: 1, name: 'alice' });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const cassetteFile = path.join(cassetteDir, `${traceId}.ndjson`);
    expect(fs.existsSync(cassetteFile)).toBe(true);
    const lines = fs.readFileSync(cassetteFile, 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const record = JSON.parse(lines[0]);
    expect(record.type).toBe('inbound');
    expect(record.identifier).toBe('GET /async-users/1');
  });
});

describe('softprobeExpressMiddleware replay trigger (Task 14.1.2)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('when mode=REPLAY and traceId is in context, activateReplayForContext(traceId) is called', async () => {
    SoftprobeContext.initGlobal({ mode: 'REPLAY', storage: replayCassette });
    const traceId = 'trace-express-replay-1';
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId, spanId: 'span-replay-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    const activateSpy = jest.spyOn(softprobe, 'activateReplayForContext');
    const req = { method: 'GET', path: '/users/1' };
    const res = { statusCode: 200, send: jest.fn() };
    let resolveNext: () => void;
    const nextCalled = new Promise<void>((r) => { resolveNext = r; });
    const next = jest.fn(() => {
      resolveNext();
    });

    softprobeExpressMiddleware(req as any, res as any, next as any);
    await nextCalled;

    expect(activateSpy).toHaveBeenCalledTimes(1);
    expect(activateSpy).toHaveBeenCalledWith(traceId);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('softprobeExpressMiddleware trace ID source (Task 14.1.3)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('identifies traceId via native OTel context (trace.getActiveSpan().spanContext().traceId), not manual header parsing', async () => {
    SoftprobeContext.initGlobal({ mode: 'REPLAY', storage: replayCassette });
    const otelTraceId = 'otel-trace-from-span-context';
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId: otelTraceId, spanId: 'span-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    const activateSpy = jest.spyOn(softprobe, 'activateReplayForContext');
    // req has trace-like headers that would be wrong if we parsed them; middleware must use OTel only
    const req = {
      method: 'GET',
      path: '/api',
      headers: {
        'x-trace-id': 'wrong-header-trace-id',
        traceparent: '00-wrong-w3c-trace-id-0000000000000000-01',
      },
    };
    const res = { statusCode: 200, send: jest.fn() };
    let resolveNext: () => void;
    const nextCalled = new Promise<void>((r) => { resolveNext = r; });
    const next = jest.fn(() => {
      resolveNext();
    });

    softprobeExpressMiddleware(req as any, res as any, next as any);
    await nextCalled;

    expect(activateSpy).toHaveBeenCalledWith(otelTraceId);
    expect(activateSpy).not.toHaveBeenCalledWith('wrong-header-trace-id');
    expect(activateSpy).not.toHaveBeenCalledWith('wrong-w3c-trace-id');
  });
});

describe('Task 14.3.1: inbound request record contains parsed JSON body when middleware is after body-parser', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('request record in NDJSON contains parsed JSON body when middleware is placed after body-parser', () => {
    const saveRecord = jest.fn<ReturnType<Cassette['saveRecord']>, Parameters<Cassette['saveRecord']>>(async () => {});
    const cassette: Cassette = {
      loadTrace: async () => [],
      saveRecord,
    };
    SoftprobeContext.initGlobal({ mode: 'CAPTURE', storage: cassette });
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId: 'trace-body-1', spanId: 'span-body-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    // Simulate body-parser has run: req.body is parsed JSON
    const parsedBody = { name: 'alice', count: 1 };
    const req = {
      method: 'POST',
      path: '/api/echo',
      body: parsedBody,
      headers: {},
    };
    const originalSend = jest.fn();
    const res = { statusCode: 201, send: originalSend };
    const next = jest.fn();

    softprobeExpressMiddleware(req as any, res as any, next as any);
    res.send({ ok: true });

    expect(saveRecord).toHaveBeenCalledTimes(1);
    expect(saveRecord.mock.calls[0]).toHaveLength(1);
    const record = saveRecord.mock.calls[0][0];
    expect(record.type).toBe('inbound');
    expect(record.requestPayload).toBeDefined();
    expect((record.requestPayload as { body?: unknown })?.body).toEqual(parsedBody);
  });

  it('GET request captures requestPayload.body when content length is unknown', () => {
    const saveRecord = jest.fn<ReturnType<Cassette['saveRecord']>, Parameters<Cassette['saveRecord']>>(async () => {});
    const cassette: Cassette = {
      loadTrace: async () => [],
      saveRecord,
    };
    SoftprobeContext.initGlobal({ mode: 'CAPTURE', storage: cassette });
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId: 'trace-get-body-1', spanId: 'span-get-body-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    const req = {
      method: 'GET',
      path: '/api/products',
      body: {},
      headers: {},
    };
    const originalSend = jest.fn();
    const res = { statusCode: 200, send: originalSend };
    const next = jest.fn();

    softprobeExpressMiddleware(req as any, res as any, next as any);
    res.send({ ok: true });

    expect(saveRecord).toHaveBeenCalledTimes(1);
    expect(saveRecord.mock.calls[0]).toHaveLength(1);
    const record = saveRecord.mock.calls[0][0];
    expect(record.type).toBe('inbound');
    expect(record.requestPayload).toEqual({ body: {} });
  });
});

describe('Task 17.3.2: middleware sets OTel context for downstream SoftprobeContext.active()', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Express middleware sets context on request; next() sees it via SoftprobeContext.active()', async () => {
    SoftprobeContext.initGlobal({ mode: 'REPLAY', storage: replayCassette });
    const traceId = 'trace-middleware-ctx-1';
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId, spanId: 'span-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);
    jest.spyOn(softprobe, 'ensureReplayLoadedForRequest').mockResolvedValue(undefined);

    let downstreamContext: ReturnType<typeof SoftprobeContext.active> | undefined;
    let resolveNext: () => void;
    const nextCalled = new Promise<void>((r) => { resolveNext = r; });
    const next = () => {
      downstreamContext = SoftprobeContext.active();
      resolveNext();
    };
    const req = { method: 'GET', path: '/api' };
    const res = { statusCode: 200, send: jest.fn() };

    softprobeExpressMiddleware(req as any, res as any, next);
    await nextCalled;

    expect(downstreamContext).toBeDefined();
    expect(downstreamContext?.traceId).toBe(traceId);
    expect(downstreamContext?.mode).toBe('REPLAY');
    expect(downstreamContext?.storage).toBeDefined();
  });
});

describe('Task 21.1.1: Header extraction in middleware — SoftprobeContext.active() returns header values over YAML defaults', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('request with coordination headers: SoftprobeContext.active() returns header values, not YAML defaults', async () => {
    const cassetteDir = path.join(os.tmpdir(), `softprobe-header-express-${Date.now()}`);
    fs.mkdirSync(cassetteDir, { recursive: true });
    const traceId = 'header-trace-99';
    fs.writeFileSync(path.join(cassetteDir, `${traceId}.ndjson`), '', 'utf8');
    SoftprobeContext.initGlobal({ mode: 'PASSTHROUGH', cassetteDirectory: cassetteDir });
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId: 'otel-span-trace', spanId: 'span-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    let downstreamContext: ReturnType<typeof SoftprobeContext.active> | undefined;
    let resolveNext: () => void;
    const nextCalled = new Promise<void>((r) => { resolveNext = r; });
    const next = () => {
      downstreamContext = SoftprobeContext.active();
      resolveNext();
    };
    const req = {
      method: 'GET',
      path: '/api',
      headers: {
        'x-softprobe-mode': 'REPLAY',
        'x-softprobe-trace-id': traceId,
      },
    };
    const res = { statusCode: 200, send: jest.fn() };

    softprobeExpressMiddleware(req as any, res as any, next);
    await nextCalled;

    expect(downstreamContext).toBeDefined();
    expect(downstreamContext?.mode).toBe('REPLAY');
    expect(downstreamContext?.traceId).toBe(traceId);
    expect(downstreamContext?.storage).toBeDefined();
    try {
      fs.unlinkSync(path.join(cassetteDir, `${traceId}.ndjson`));
      fs.rmdirSync(cassetteDir);
    } catch {
      // ignore cleanup errors
    }
  });
});

describe('Task 5.1: Express middleware uses SoftprobeContext.run(options, next)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('downstream handler observes active mode, traceId, and storage', () => {
    const cassetteDir = path.join(os.tmpdir(), `softprobe-express-5-1-${Date.now()}`);
    fs.mkdirSync(cassetteDir, { recursive: true });
    SoftprobeContext.initGlobal({ mode: 'CAPTURE', cassetteDirectory: cassetteDir });
    const traceId = 'trace-task-5-1';
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId, spanId: 'span-task-5-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    const req = {
      method: 'GET',
      path: '/task-5-1',
      headers: {},
    };
    const res = { statusCode: 200, send: jest.fn() };
    let seenMode: ReturnType<typeof SoftprobeContext.getMode> | undefined;
    let seenTraceId = '';
    let seenStorage: ReturnType<typeof SoftprobeContext.getCassette> | undefined;
    const next = () => {
      seenMode = SoftprobeContext.getMode();
      seenTraceId = SoftprobeContext.getTraceId();
      seenStorage = SoftprobeContext.getCassette();
    };

    softprobeExpressMiddleware(req as any, res as any, next);

    expect(seenMode).toBe('CAPTURE');
    expect(seenTraceId).toBe(traceId);
    expect(seenStorage).toBeDefined();
    expect(typeof seenStorage?.loadTrace).toBe('function');
    expect(typeof seenStorage?.saveRecord).toBe('function');
  });
});

describe('Task 5.4: Header coordination overrides defaults via run options in Express', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('array coordination headers override default mode and span trace id in active context', async () => {
    SoftprobeContext.initGlobal({ mode: 'PASSTHROUGH', storage: replayCassette });
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId: 'span-trace-express-5-4', spanId: 'span-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);
    jest.spyOn(softprobe, 'ensureReplayLoadedForRequest').mockResolvedValue(undefined);

    let downstreamContext: ReturnType<typeof SoftprobeContext.active> | undefined;
    let resolveNext: () => void;
    const nextCalled = new Promise<void>((r) => { resolveNext = r; });
    const next = () => {
      downstreamContext = SoftprobeContext.active();
      resolveNext();
    };
    const req = {
      method: 'GET',
      path: '/task-5-4-express',
      headers: {
        'x-softprobe-mode': ['REPLAY'],
        'x-softprobe-trace-id': ['header-trace-express-5-4'],
      },
    };
    const res = { statusCode: 200, send: jest.fn() };

    softprobeExpressMiddleware(req as any, res as any, next);
    await nextCalled;

    expect(downstreamContext).toBeDefined();
    expect(downstreamContext?.mode).toBe('REPLAY');
    expect(downstreamContext?.traceId).toBe('header-trace-express-5-4');
  });
});

describe('Task 6.5 inbound capture path writes through context cassette helper', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('queueInboundResponse writes with active context trace id', async () => {
    const saveRecord = jest.fn(async () => {});
    const cassette: Cassette = {
      loadTrace: async () => [],
      saveRecord,
    };

    await SoftprobeContext.run(
      { mode: 'CAPTURE', traceId: 'context-trace-inbound-6-5', storage: cassette },
      async () => {
        CaptureEngine.queueInboundResponse('ignored-trace-id', {
          status: 200,
          body: { ok: true },
          identifier: 'GET /task-6-5-inbound',
        });
        await Promise.resolve();
      }
    );

    expect(saveRecord).toHaveBeenCalledTimes(1);
    expect(saveRecord.mock.calls[0]).toHaveLength(1);
    expect(saveRecord).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 'context-trace-inbound-6-5', type: 'inbound', protocol: 'http' })
    );
  });
});

describe('Task 8.2: boot-wired cassette instance is passed into Express request scope', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the same configured cassette object when no cassette-path header is provided', () => {
    const configuredCassette: Cassette = {
      loadTrace: async () => [],
      saveRecord: async () => {},
    };
    SoftprobeContext.initGlobal({ mode: 'CAPTURE', storage: configuredCassette });
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId: 'trace-task-8-2-express', spanId: 'span-task-8-2-express' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    const req = { method: 'GET', path: '/task-8-2-express', headers: {} };
    const res = { statusCode: 200, send: jest.fn() };
    let seenStorage: ReturnType<typeof SoftprobeContext.getCassette> | undefined;
    const next = () => {
      seenStorage = SoftprobeContext.getCassette();
    };

    softprobeExpressMiddleware(req as any, res as any, next);

    expect(seenStorage).toBe(configuredCassette);
  });
});
