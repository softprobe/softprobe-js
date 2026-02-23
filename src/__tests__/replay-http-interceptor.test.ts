/**
 * Task 9.4: HTTP replay interceptor (MSW)
 * - ignoreUrls bypasses matcher
 * - MOCK returns recorded payload response
 * - CONTINUE + STRICT returns JSON 500 with x-softprobe-error
 * - CONTINUE + DEV leaves request untouched (passthrough)
 */

import { handleHttpReplayRequest } from '../replay/http';

type MockController = { respondWith: jest.Mock<void, [Response]> };

function makeController(): MockController {
  return { respondWith: jest.fn<void, [Response]>() };
}

describe('HTTP replay interceptor (Task 9.4)', () => {
  const prevStrict = process.env.SOFTPROBE_STRICT_REPLAY;

  afterEach(() => {
    if (prevStrict === undefined) delete process.env.SOFTPROBE_STRICT_REPLAY;
    else process.env.SOFTPROBE_STRICT_REPLAY = prevStrict;
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
    process.env.SOFTPROBE_STRICT_REPLAY = '1';
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
    delete process.env.SOFTPROBE_STRICT_REPLAY;
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
