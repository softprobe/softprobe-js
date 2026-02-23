/**
 * Task 15.1.2: Downstream shims check baggage for mode.
 * Test: outbound fetch shim automatically switches to MOCK when baggage contains softprobe-mode: REPLAY.
 */
import { propagation } from '@opentelemetry/api';
import { handleHttpReplayRequest } from '../replay/http';
import { setGlobalReplayMatcher } from '../api';
import { SoftprobeMatcher } from '../replay/softprobe-matcher';
import { createDefaultMatcher } from '../replay/extract-key';
import type { SoftprobeCassetteRecord } from '../types/schema';

function makeController() {
  return { respondWith: jest.fn<void, [Response]>() };
}

/** Baggage stub with softprobe-mode=REPLAY for getEntry('softprobe-mode'). */
const replayBaggage = {
  getEntry: (key: string) => (key === 'softprobe-mode' ? { value: 'REPLAY' } : undefined),
};

describe('HTTP replay shim + baggage (Task 15.1.2)', () => {
  const originalMode = process.env.SOFTPROBE_MODE;
  let getActiveBaggageSpy: jest.SpyInstance;

  beforeAll(() => {
    getActiveBaggageSpy = jest.spyOn(propagation, 'getActiveBaggage').mockReturnValue(replayBaggage as ReturnType<typeof propagation.getActiveBaggage>);
  });

  afterAll(() => {
    getActiveBaggageSpy.mockRestore();
  });

  afterEach(() => {
    setGlobalReplayMatcher(undefined);
    if (originalMode !== undefined) process.env.SOFTPROBE_MODE = originalMode;
    else delete process.env.SOFTPROBE_MODE;
  });

  it('outbound fetch shim switches to MOCK when baggage contains softprobe-mode: REPLAY', async () => {
    process.env.SOFTPROBE_MODE = 'CAPTURE'; // not REPLAY, so without baggage we would not use global matcher

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

    await handleHttpReplayRequest(
      {
        request: new Request('http://example.com/', { method: 'GET' }),
        controller,
      },
      {} // no custom match — handler uses getActiveMatcher(), which now checks baggage
    );

    expect(controller.respondWith).toHaveBeenCalledTimes(1);
    const response = controller.respondWith.mock.calls[0][0] as Response;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('mocked-by-baggage');
  });
});
