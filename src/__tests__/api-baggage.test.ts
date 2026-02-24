/**
 * Task 15.1.1: Inject softprobe-mode: REPLAY into OTel Baggage.
 * Test: setting global REPLAY mode adds entry to current OTel baggage.
 */
import { propagation } from '@opentelemetry/api';
import { getContextWithReplayBaggage } from '../api/baggage';
import { initGlobalContext } from '../context';

describe('api/baggage (OTel baggage propagation)', () => {
  afterEach(() => {
    initGlobalContext({});
  });

  it('adds softprobe-mode=REPLAY to current OTel baggage when mode=REPLAY', () => {
    initGlobalContext({ mode: 'REPLAY' });

    const ctx = getContextWithReplayBaggage();
    const bag = propagation.getBaggage(ctx);
    const entry = bag?.getEntry('softprobe-mode');

    expect(entry).toBeDefined();
    expect(entry?.value).toBe('REPLAY');
  });

  it('does not add softprobe-mode when mode is not REPLAY', () => {
    initGlobalContext({ mode: 'CAPTURE' });

    const ctx = getContextWithReplayBaggage();
    const bag = propagation.getBaggage(ctx);
    const entry = bag?.getEntry('softprobe-mode');

    expect(entry).toBeUndefined();
  });
});
