/**
 * Task 10.3.1: Outbound HTTP capture — request/response written as type=outbound.
 * Test: identifier matches METHOD url.
 *
 * Plan: when capture uses interceptor, undici hook does not call saveRecord (interceptor writes with body).
 */

import type { CassetteStore } from '../store/cassette-store';
import * as otelApi from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { setCaptureStore, setCaptureUsesInterceptor } from '../capture/store-accessor';
import { buildUndiciResponseHook, type UndiciResultLike } from '../capture/undici';
import { SoftprobeContext } from '../context';
import type { Cassette } from '../types/schema';

afterEach(() => {
  setCaptureStore(undefined);
  setCaptureUsesInterceptor(false);
});

describe('Undici outbound capture (Task 10.3)', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
  });

  it('10.3.1 captures outbound request/response into record with identifier = METHOD url', () => {
    const saveRecord = jest.fn<void, [Parameters<CassetteStore['saveRecord']>[0]]>();
    const mockStore = { saveRecord } as unknown as CassetteStore;
    setCaptureStore(mockStore);

    const responseHook = buildUndiciResponseHook();
    const result: UndiciResultLike = {
      request: { method: 'POST', url: 'https://api.example.com/echo' },
      response: { statusCode: 201, body: { id: 1 } },
    };
    const mockSpan = {
      spanContext: () => ({ traceId: 'trace-1', spanId: 'span-1' }),
      parentSpanId: 'parent-1',
      name: 'fetch',
      setAttribute: () => {},
    };

    responseHook(mockSpan, result);

    expect(saveRecord).toHaveBeenCalledTimes(1);
    const record = saveRecord.mock.calls[0][0];
    expect(record.type).toBe('outbound');
    expect(record.protocol).toBe('http');
    expect(record.identifier).toBe('POST https://api.example.com/echo');
    expect(record.responsePayload).toEqual({ statusCode: 201, body: { id: 1 } });
  });

  it('when capture uses interceptor, hook sets span attributes but does not call saveRecord', () => {
    const saveRecord = jest.fn<void, [Parameters<CassetteStore['saveRecord']>[0]]>();
    const mockStore = { saveRecord } as unknown as CassetteStore;
    setCaptureStore(mockStore);
    setCaptureUsesInterceptor(true);

    const setAttribute = jest.fn();
    const responseHook = buildUndiciResponseHook();
    const result: UndiciResultLike = {
      request: { method: 'GET', url: 'https://example.com' },
      response: { statusCode: 200 },
    };
    const mockSpan = {
      spanContext: () => ({ traceId: 't', spanId: 's' }),
      parentSpanId: undefined,
      name: 'fetch',
      setAttribute,
    };

    responseHook(mockSpan, result);

    expect(saveRecord).not.toHaveBeenCalled();
    expect(setAttribute).toHaveBeenCalledWith('softprobe.protocol', 'http');
    expect(setAttribute).toHaveBeenCalledWith('softprobe.identifier', 'GET https://example.com');
  });

  it('Task 6.5 outbound capture writes through context cassette helper with active trace id', async () => {
    const saveRecord = jest.fn(async () => {});
    const cassette: Cassette = {
      loadTrace: async () => [],
      saveRecord,
    };
    const responseHook = buildUndiciResponseHook();
    const result: UndiciResultLike = {
      request: { method: 'GET', url: 'https://api.example.com/users' },
      response: { statusCode: 200, body: { ok: true } },
    };
    const mockSpan = {
      spanContext: () => ({ traceId: 'span-trace-ignored', spanId: 'span-1' }),
      parentSpanId: 'parent-1',
      name: 'fetch',
      setAttribute: () => {},
    };

    await SoftprobeContext.run(
      { mode: 'CAPTURE', traceId: 'context-trace-http-6-5', storage: cassette },
      async () => {
        responseHook(mockSpan, result);
        await Promise.resolve();
      }
    );

    expect(saveRecord).toHaveBeenCalledTimes(1);
    expect(saveRecord).toHaveBeenCalledWith(
      'context-trace-http-6-5',
      expect.objectContaining({ type: 'outbound', protocol: 'http' })
    );
  });
});
