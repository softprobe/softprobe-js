/**
 * Task 9.4: HTTP replay interceptor (MSW)
 * - ignoreUrls bypasses matcher
 * - MOCK returns recorded payload response
 * - CONTINUE + STRICT returns JSON 500 with x-softprobe-error
 * - CONTINUE + DEV leaves request untouched (passthrough)
 *
 * Plan: CAPTURE branch — when mode is CAPTURE, perform request with bypass fetch, tap response body, saveRecord, respondWith.
 */

import type { Cassette } from '../types/schema';
import { handleHttpReplayRequest } from '../replay/http';
import { SoftprobeContext } from '../context';
import { softprobe } from '../api';
import { SoftprobeMatcher } from '../replay/softprobe-matcher';
const { context } = require('@opentelemetry/api');
const { AsyncHooksContextManager } = require('@opentelemetry/context-async-hooks');
const otelApi = require('@opentelemetry/api');

type MockController = { respondWith: jest.Mock<void, [Response]> };

function makeController(): MockController {
  return { respondWith: jest.fn<void, [Response]>() };
}

describe('HTTP replay interceptor (Task 9.4)', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
    SoftprobeContext.initGlobal({ mode: 'REPLAY', strictReplay: false });
  });
  afterEach(() => {
    SoftprobeContext.initGlobal({ mode: 'REPLAY', strictReplay: false });
  });

  it('9.4.1 ignores configured URLs and does not call matcher', async () => {
    const controller = makeController();
    const matcher = new SoftprobeMatcher();
    const match = jest.fn(() => ({ action: 'MOCK' as const, payload: { status: 200, body: 'x' } }));
    matcher.use(match);
    const ctx = SoftprobeContext.withData(context.active(), { mode: 'REPLAY', traceId: 'http-9-4-1', matcher });

    await context.with(ctx, async () => {
      await handleHttpReplayRequest(
        {
          request: new Request('https://collector.local/v1/traces', { method: 'POST' }),
          controller,
        },
        {
          shouldIgnoreUrl: (url) => Boolean(url?.includes('/v1/traces')),
        }
      );
    });

    expect(match).not.toHaveBeenCalled();
    expect(controller.respondWith).not.toHaveBeenCalled();
  });

  it('9.4.2 MOCK responds with recorded payload (status/body)', async () => {
    const controller = makeController();
    const matcher = new SoftprobeMatcher();
    matcher.use(() => ({
      action: 'MOCK',
      payload: {
        status: 201,
        body: { ok: true },
        headers: { 'x-test': '1', 'content-type': 'application/json' },
      },
    }));
    const ctx = SoftprobeContext.withData(context.active(), { mode: 'REPLAY', traceId: 'http-9-4-2', matcher });

    await context.with(ctx, async () => {
      await handleHttpReplayRequest(
        {
          request: new Request('https://api.example.com/users', { method: 'GET' }),
          controller,
        },
        {
          shouldIgnoreUrl: () => false,
        }
      );
    });

    expect(controller.respondWith).toHaveBeenCalledTimes(1);
    const response = controller.respondWith.mock.calls[0][0];
    expect(response.status).toBe(201);
    expect(response.headers.get('x-test')).toBe('1');
    expect(await response.text()).toBe('{"ok":true}');
  });

  it('9.4.3 CONTINUE + STRICT returns JSON error Response(500)', async () => {
    SoftprobeContext.initGlobal({ mode: 'REPLAY', strictReplay: true });
    const controller = makeController();
    const matcher = new SoftprobeMatcher();
    matcher.use(() => ({ action: 'CONTINUE' as const }));
    const ctx = SoftprobeContext.withData(context.active(), { mode: 'REPLAY', traceId: 'http-9-4-3', matcher, strictReplay: true });

    await context.with(ctx, async () => {
      await handleHttpReplayRequest(
        {
          request: new Request('https://api.example.com/users', { method: 'GET' }),
          controller,
        },
        {
          shouldIgnoreUrl: () => false,
        }
      );
    });

    expect(controller.respondWith).toHaveBeenCalledTimes(1);
    const response = controller.respondWith.mock.calls[0][0];
    expect(response.status).toBe(500);
    expect(response.headers.get('x-softprobe-error')).toBe('true');
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({
      error: '[Softprobe] No recorded traces found for http request',
    });
  });

  it('9.4.4 CONTINUE + DEV allows passthrough (no response)', async () => {
    SoftprobeContext.initGlobal({ strictReplay: false });
    const controller = makeController();
    const matcher = new SoftprobeMatcher();
    matcher.use(() => ({ action: 'CONTINUE' as const }));
    const ctx = SoftprobeContext.withData(context.active(), { mode: 'REPLAY', traceId: 'http-9-4-4', matcher, strictReplay: false });

    await context.with(ctx, async () => {
      await handleHttpReplayRequest(
        {
          request: new Request('https://api.example.com/users', { method: 'GET' }),
          controller,
        },
        {
          shouldIgnoreUrl: () => false,
        }
      );
    });

    expect(controller.respondWith).not.toHaveBeenCalled();
  });
});

/**
 * Task 18.2.2: HTTP interceptor retrieves mode from active context to decide between MOCK and PASSTHROUGH.
 */
describe('Task 18.2.2 HTTP interceptor context mode', () => {
  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
  });

  it('when mode is REPLAY, interceptor uses matcher and can MOCK', async () => {
    const controller = makeController();
    const matcher = new SoftprobeMatcher();
    const match = jest.fn(() => ({ action: 'MOCK' as const, payload: { status: 200, body: { replayed: true } } }));
    matcher.use(match);

    const activeCtx = context.active();
    const ctxReplay = SoftprobeContext.withData(activeCtx, {
      mode: 'REPLAY',
      matcher,
    });

    await context.with(ctxReplay, async () => {
      await handleHttpReplayRequest(
        {
          request: new Request('https://api.example.com/foo', { method: 'GET' }),
          controller,
        },
        { shouldIgnoreUrl: () => false }
      );
    });

    expect(match).toHaveBeenCalled();
    expect(controller.respondWith).toHaveBeenCalledTimes(1);
    const response = controller.respondWith.mock.calls[0][0];
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ replayed: true });
  });

  it('when mode is PASSTHROUGH, interceptor does not MOCK (passthrough)', async () => {
    const controller = makeController();
    const matcher = new SoftprobeMatcher();
    matcher.use(() => ({ action: 'MOCK' as const, payload: { status: 200, body: 'ignored' } }));

    const activeCtx = context.active();
    const ctxPassthrough = SoftprobeContext.withData(activeCtx, {
      mode: 'PASSTHROUGH',
      matcher,
    });

    await context.with(ctxPassthrough, async () => {
      await handleHttpReplayRequest(
        {
          request: new Request('https://api.example.com/bar', { method: 'GET' }),
          controller,
        },
        { shouldIgnoreUrl: () => false }
      );
    });

    expect(controller.respondWith).not.toHaveBeenCalled();
  });
});

/**
 * Plan: CAPTURE branch — when mode is CAPTURE, bypass fetch, tap response with tapReadableStream, saveRecord via context cassette, respondWith.
 * Task 13.10: Use run-scoped storage instead of setCaptureStore.
 */
describe('HTTP interceptor CAPTURE branch', () => {
  afterEach(() => {
    SoftprobeContext.initGlobal({ mode: 'REPLAY' });
  });

  it('when mode is CAPTURE, performs request with bypassFetch, taps body, saves outbound record, responds with response', async () => {
    const saveRecord = jest.fn<Promise<void>, [import('../types/schema').SoftprobeCassetteRecord]>(async () => {});
    const mockCassette: Cassette = { loadTrace: async () => [], saveRecord };

    await SoftprobeContext.run({ mode: 'CAPTURE', traceId: 'trace-http-cap', storage: mockCassette }, async () => {
      const controller = makeController();
      const bypassFetch = jest.fn().mockResolvedValue(new Response('captured-body', { status: 200 }));

      await handleHttpReplayRequest(
        {
          request: new Request('https://example.com/', { method: 'GET' }),
          controller,
        },
        { shouldIgnoreUrl: () => false, bypassFetch }
      );

      expect(controller.respondWith).toHaveBeenCalledTimes(1);
      const response = controller.respondWith.mock.calls[0][0];
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('captured-body');
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(saveRecord).toHaveBeenCalledTimes(1);
    const record = saveRecord.mock.calls[0][0];
    expect(record.type).toBe('outbound');
    expect(record.protocol).toBe('http');
    expect(record.identifier).toBe('GET https://example.com/');
    expect((record.responsePayload as { statusCode?: number; body?: string }).statusCode).toBe(200);
    expect((record.responsePayload as { statusCode?: number; body?: string }).body).toBe('captured-body');
  });
});

describe('Task 6.3 HTTP replay interceptor uses active context matcher only', () => {
  const { context } = require('@opentelemetry/api');
  const { AsyncHooksContextManager } = require('@opentelemetry/context-async-hooks');
  const otelApi = require('@opentelemetry/api');

  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
  });

  afterEach(() => {
    softprobe.setGlobalReplayMatcher(undefined);
    SoftprobeContext.initGlobal({ mode: 'REPLAY', strictReplay: false });
  });

  it('does not use global matcher fallback when active replay context has no matcher', async () => {
    const globalMatcher = new SoftprobeMatcher();
    globalMatcher.use(() => ({
      action: 'MOCK',
      payload: { status: 200, body: { from: 'global-http-matcher' } },
    }));
    softprobe.setGlobalReplayMatcher(globalMatcher);

    const controller = makeController();
    const ctxReplayNoMatcher = SoftprobeContext.withData(context.active(), {
      mode: 'REPLAY',
      traceId: 'http-task-6-3',
    });

    await context.with(ctxReplayNoMatcher, async () => {
      await handleHttpReplayRequest(
        {
          request: new Request('https://api.example.com/from-context-only', { method: 'GET' }),
          controller,
        },
        { shouldIgnoreUrl: () => false }
      );
    });

    expect(controller.respondWith).toHaveBeenCalledTimes(1);
    const response = controller.respondWith.mock.calls[0][0];
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Softprobe Replay Error',
      details: 'Softprobe replay matcher is required in REPLAY mode',
    });
  });
});
