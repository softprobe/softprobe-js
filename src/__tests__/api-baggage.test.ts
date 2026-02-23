/**
 * Task 15.1.1: Inject softprobe-mode: REPLAY into OTel Baggage.
 * Test: setting global REPLAY mode adds entry to current OTel baggage.
 */
import { propagation } from '@opentelemetry/api';
import { getContextWithReplayBaggage } from '../api/baggage';

describe('api/baggage (OTel baggage propagation)', () => {
  const originalMode = process.env.SOFTPROBE_MODE;

  afterEach(() => {
    if (originalMode !== undefined) process.env.SOFTPROBE_MODE = originalMode;
    else delete process.env.SOFTPROBE_MODE;
  });

  it('adds softprobe-mode=REPLAY to current OTel baggage when SOFTPROBE_MODE=REPLAY', () => {
    process.env.SOFTPROBE_MODE = 'REPLAY';

    const ctx = getContextWithReplayBaggage();
    const bag = propagation.getBaggage(ctx);
    const entry = bag?.getEntry('softprobe-mode');

    expect(entry).toBeDefined();
    expect(entry?.value).toBe('REPLAY');
  });

  it('does not add softprobe-mode when SOFTPROBE_MODE is not REPLAY', () => {
    process.env.SOFTPROBE_MODE = 'CAPTURE';

    const ctx = getContextWithReplayBaggage();
    const bag = propagation.getBaggage(ctx);
    const entry = bag?.getEntry('softprobe-mode');

    expect(entry).toBeUndefined();
  });
});
