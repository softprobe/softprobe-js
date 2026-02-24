/**
 * Task 15.1.2: Downstream shims check baggage for mode.
 * Task 18.2.2: HTTP interceptor uses getSoftprobeContext().mode (context); middleware syncs baggage → context.
 * Test: when context has REPLAY (e.g. set from baggage by middleware), outbound fetch shim switches to MOCK.
 */
import * as otelApi from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { handleHttpReplayRequest } from '../replay/http';
import { setGlobalReplayMatcher } from '../api';
import { setSoftprobeContext } from '../context';
import { SoftprobeMatcher } from '../replay/softprobe-matcher';
import { createDefaultMatcher } from '../replay/extract-key';
import type { SoftprobeCassetteRecord } from '../types/schema';
import { initGlobalContext } from '../context';

const { context, propagation } = otelApi;

function makeController() {
  return { respondWith: jest.fn<void, [Response]>() };
}

/** Baggage stub with softprobe-mode=REPLAY for getEntry('softprobe-mode'). */
const replayBaggage = {
  getEntry: (key: string) => (key === 'softprobe-mode' ? { value: 'REPLAY' } : undefined),
};

describe('HTTP replay shim + baggage (Task 15.1.2)', () => {
  let getActiveBaggageSpy: jest.SpyInstance;

  beforeAll(() => {
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    otelApi.context.setGlobalContextManager(contextManager);
    getActiveBaggageSpy = jest.spyOn(propagation, 'getActiveBaggage').mockReturnValue(replayBaggage as ReturnType<typeof propagation.getActiveBaggage>);
  });

  afterAll(() => {
    getActiveBaggageSpy.mockRestore();
  });

  afterEach(() => {
    setGlobalReplayMatcher(undefined);
    initGlobalContext({});
  });

  it('outbound fetch shim switches to MOCK when baggage contains softprobe-mode: REPLAY', async () => {
    initGlobalContext({ mode: 'CAPTURE' }); // global not REPLAY; active context will be set to REPLAY (as middleware would from baggage)

    const record: SoftprobeCassetteRecord = {
      version: '4.1',
      traceId: 't1',
      spanId: 's1',
      timestamp: new Date().toISOString(),
      type: 'outbound',
      protocol: 'http',
      identifier: 'GET http://example.com/',
      responsePayload: { body: 'mocked-by-baggage', statusCode: 200 },
    };
    const matcher = new SoftprobeMatcher();
    matcher._setRecords([record]);
    matcher.use(createDefaultMatcher());
    setGlobalReplayMatcher(matcher);

    const controller = makeController();

    const ctxReplay = setSoftprobeContext(context.active(), {
      mode: 'REPLAY',
      cassettePath: '',
      matcher,
    });
    await context.with(ctxReplay, async () => {
      await handleHttpReplayRequest(
        {
          request: new Request('http://example.com/', { method: 'GET' }),
          controller,
        },
        {} // no custom match — handler uses getSoftprobeContext().mode (REPLAY) and getActiveMatcher()
      );
    });

    expect(controller.respondWith).toHaveBeenCalledTimes(1);
    const response = controller.respondWith.mock.calls[0][0] as Response;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('mocked-by-baggage');
  });
});
