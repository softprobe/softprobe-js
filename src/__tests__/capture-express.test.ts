/**
 * Task 14.1.1 / 14.1.2: Express middleware capture and replay paths.
 * Task 14.3.1: Inbound request record contains parsed JSON body when middleware is after body-parser.
 * Task 17.3.2: Middleware sets OTel context; downstream code can retrieve via getSoftprobeContext().
 */

import * as otelApi from '@opentelemetry/api';
import { trace } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';

import type { CassetteStore } from '../store/cassette-store';
import { CaptureEngine, softprobeExpressMiddleware } from '../capture/express';
import * as storeAccessor from '../capture/store-accessor';
import { softprobe } from '../api';
import { getSoftprobeContext, initGlobalContext } from '../context';

describe('softprobeExpressMiddleware capture path (Task 14.1.1)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('when mode=CAPTURE, res.send triggers CaptureEngine.queueInboundResponse with status and body', () => {
    initGlobalContext({ mode: 'CAPTURE' });
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId: 'trace-express-1', spanId: 'span-express-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    const queueSpy = jest.spyOn(CaptureEngine, 'queueInboundResponse');
    const originalSend = jest.fn();
    const req = { method: 'GET', path: '/users/1' };
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
      })
    );
    expect(originalSend).toHaveBeenCalledWith({ id: 1, name: 'alice' });
  });
});

describe('softprobeExpressMiddleware replay trigger (Task 14.1.2)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('when mode=REPLAY and traceId is in context, activateReplayForContext(traceId) is called', () => {
    initGlobalContext({ mode: 'REPLAY' });
    const traceId = 'trace-express-replay-1';
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId, spanId: 'span-replay-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    const activateSpy = jest.spyOn(softprobe, 'activateReplayForContext');
    const req = { method: 'GET', path: '/users/1' };
    const res = { statusCode: 200, send: jest.fn() };
    const next = jest.fn();

    softprobeExpressMiddleware(req as any, res as any, next as any);

    expect(activateSpy).toHaveBeenCalledTimes(1);
    expect(activateSpy).toHaveBeenCalledWith(traceId);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('softprobeExpressMiddleware trace ID source (Task 14.1.3)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('identifies traceId via native OTel context (trace.getActiveSpan().spanContext().traceId), not manual header parsing', () => {
    initGlobalContext({ mode: 'REPLAY' });
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
    const next = jest.fn();

    softprobeExpressMiddleware(req as any, res as any, next as any);

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
    initGlobalContext({ mode: 'CAPTURE' });
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId: 'trace-body-1', spanId: 'span-body-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    const saveRecord = jest.fn<void, [Parameters<CassetteStore['saveRecord']>[0]]>();
    const mockStore = { saveRecord } as unknown as CassetteStore;
    jest.spyOn(storeAccessor, 'getCaptureStore').mockReturnValue(mockStore as ReturnType<typeof storeAccessor.getCaptureStore>);

    // Simulate body-parser has run: req.body is parsed JSON
    const parsedBody = { name: 'alice', count: 1 };
    const req = { method: 'POST', path: '/api/echo', body: parsedBody };
    const originalSend = jest.fn();
    const res = { statusCode: 201, send: originalSend };
    const next = jest.fn();

    softprobeExpressMiddleware(req as any, res as any, next as any);
    res.send({ ok: true });

    expect(saveRecord).toHaveBeenCalledTimes(1);
    const record = saveRecord.mock.calls[0][0];
    expect(record.type).toBe('inbound');
    expect(record.requestPayload).toBeDefined();
    expect((record.requestPayload as { body?: unknown })?.body).toEqual(parsedBody);
  });
});

describe('Task 17.3.2: middleware sets OTel context for downstream getSoftprobeContext()', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Express middleware sets context on request; next() sees it via getSoftprobeContext()', () => {
    initGlobalContext({ mode: 'REPLAY', cassettePath: '/cassettes.ndjson' });
    const traceId = 'trace-middleware-ctx-1';
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId, spanId: 'span-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    let downstreamContext: ReturnType<typeof getSoftprobeContext> | undefined;
    const next = () => {
      downstreamContext = getSoftprobeContext();
    };
    const req = { method: 'GET', path: '/api' };
    const res = { statusCode: 200, send: jest.fn() };

    softprobeExpressMiddleware(req as any, res as any, next);

    expect(downstreamContext).toBeDefined();
    expect(downstreamContext?.traceId).toBe(traceId);
    expect(downstreamContext?.mode).toBe('REPLAY');
    expect(downstreamContext?.cassettePath).toBe('/cassettes.ndjson');
  });
});

describe('Task 21.1.1: Header extraction in middleware — getSoftprobeContext() returns header values over YAML defaults', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('request with coordination headers: getSoftprobeContext() returns header values, not YAML defaults', () => {
    initGlobalContext({ mode: 'PASSTHROUGH', cassettePath: '/yaml-default.ndjson' });
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId: 'otel-span-trace', spanId: 'span-1' }),
    } as ReturnType<typeof trace.getActiveSpan>);

    let downstreamContext: ReturnType<typeof getSoftprobeContext> | undefined;
    const next = () => {
      downstreamContext = getSoftprobeContext();
    };
    const req = {
      method: 'GET',
      path: '/api',
      headers: {
        'x-softprobe-mode': 'REPLAY',
        'x-softprobe-trace-id': 'header-trace-99',
        'x-softprobe-cassette-path': '/header-cassette.ndjson',
      },
    };
    const res = { statusCode: 200, send: jest.fn() };

    softprobeExpressMiddleware(req as any, res as any, next);

    expect(downstreamContext).toBeDefined();
    expect(downstreamContext?.mode).toBe('REPLAY');
    expect(downstreamContext?.traceId).toBe('header-trace-99');
    expect(downstreamContext?.cassettePath).toBe('/header-cassette.ndjson');
  });
});
