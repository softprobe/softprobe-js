/**
 * Task 9.4: HTTP replay interceptor (MSW)
 * - ignoreUrls bypasses matcher
 * - MOCK returns recorded payload response
 * - CONTINUE + STRICT returns JSON 500 with x-softprobe-error
 * - CONTINUE + DEV leaves request untouched (passthrough)
 */

import { handleHttpReplayRequest } from '../replay/http';
import { initGlobalContext } from '../context';

type MockController = { respondWith: jest.Mock<void, [Response]> };

function makeController(): MockController {
  return { respondWith: jest.fn<void, [Response]>() };
}

describe('HTTP replay interceptor (Task 9.4)', () => {
  beforeAll(() => {
    initGlobalContext({ mode: 'REPLAY', strictReplay: false });
  });
  afterEach(() => {
    initGlobalContext({ mode: 'REPLAY', strictReplay: false });
  });

  it('9.4.1 ignores configured URLs and does not call matcher', async () => {
    const controller = makeController();
    const match = jest.fn(() => ({ action: 'MOCK' as const, payload: { status: 200, body: 'x' } }));

    await handleHttpReplayRequest(
      {
        request: new Request('https://collector.local/v1/traces', { method: 'POST' }),
        controller,
      },
      {
        shouldIgnoreUrl: (url) => Boolean(url?.includes('/v1/traces')),
        match,
      }
    );

    expect(match).not.toHaveBeenCalled();
    expect(controller.respondWith).not.toHaveBeenCalled();
  });

  it('9.4.2 MOCK responds with recorded payload (status/body)', async () => {
    const controller = makeController();

    await handleHttpReplayRequest(
      {
        request: new Request('https://api.example.com/users', { method: 'GET' }),
        controller,
      },
      {
        shouldIgnoreUrl: () => false,
        match: () => ({
          action: 'MOCK',
          payload: {
            status: 201,
            body: { ok: true },
            headers: { 'x-test': '1', 'content-type': 'application/json' },
          },
        }),
      }
    );

    expect(controller.respondWith).toHaveBeenCalledTimes(1);
    const response = controller.respondWith.mock.calls[0][0];
    expect(response.status).toBe(201);
    expect(response.headers.get('x-test')).toBe('1');
    expect(await response.text()).toBe('{"ok":true}');
  });

  it('9.4.3 CONTINUE + STRICT returns JSON error Response(500)', async () => {
    initGlobalContext({ mode: 'REPLAY', strictReplay: true });
    const controller = makeController();

    await handleHttpReplayRequest(
      {
        request: new Request('https://api.example.com/users', { method: 'GET' }),
        controller,
      },
      {
        shouldIgnoreUrl: () => false,
        match: () => ({ action: 'CONTINUE' }),
      }
    );

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
    initGlobalContext({ strictReplay: false });
    const controller = makeController();

    await handleHttpReplayRequest(
      {
        request: new Request('https://api.example.com/users', { method: 'GET' }),
        controller,
      },
      {
        shouldIgnoreUrl: () => false,
        match: () => ({ action: 'CONTINUE' }),
      }
    );

    expect(controller.respondWith).not.toHaveBeenCalled();
  });
});

/**
 * Task 18.2.2: HTTP interceptor retrieves mode from active context to decide between MOCK and PASSTHROUGH.
 */
describe('Task 18.2.2 HTTP interceptor context mode', () => {
  const { context } = require('@opentelemetry/api');
  const { AsyncHooksContextManager } = require('@opentelemetry/context-async-hooks');
  const otelApi = require('@opentelemetry/api');
  const { setSoftprobeContext } = require('../context');

  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
  });

  it('when mode is REPLAY, interceptor uses matcher and can MOCK', async () => {
    const controller = makeController();
    const match = jest.fn(() => ({ action: 'MOCK' as const, payload: { status: 200, body: { replayed: true } } }));

    const activeCtx = context.active();
    const ctxReplay = setSoftprobeContext(activeCtx, {
      mode: 'REPLAY',
      cassettePath: '',
    });

    await context.with(ctxReplay, async () => {
      await handleHttpReplayRequest(
        {
          request: new Request('https://api.example.com/foo', { method: 'GET' }),
          controller,
        },
        { shouldIgnoreUrl: () => false, match }
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
    const match = jest.fn(() => ({ action: 'MOCK' as const, payload: { status: 200, body: 'ignored' } }));

    const activeCtx = context.active();
    const ctxPassthrough = setSoftprobeContext(activeCtx, {
      mode: 'PASSTHROUGH',
      cassettePath: '',
    });

    await context.with(ctxPassthrough, async () => {
      await handleHttpReplayRequest(
        {
          request: new Request('https://api.example.com/bar', { method: 'GET' }),
          controller,
        },
        { shouldIgnoreUrl: () => false, match }
      );
    });

    expect(controller.respondWith).not.toHaveBeenCalled();
  });
});
