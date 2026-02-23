/**
 * Task 11.1.1: softprobe/init reads SOFTPROBE_MODE.
 * Test: requires module under REPLAY/CAPTURE modes.
 */

describe('softprobe/init boot', () => {
  const originalEnv = process.env.SOFTPROBE_MODE;

  afterEach(() => {
    if (originalEnv !== undefined) process.env.SOFTPROBE_MODE = originalEnv;
    else delete process.env.SOFTPROBE_MODE;
  });

  it('runs capture init when SOFTPROBE_MODE=CAPTURE', () => {
    const initCapture = jest.fn();
    process.env.SOFTPROBE_MODE = 'CAPTURE';

    jest.isolateModules(() => {
      jest.doMock('../capture/init', () => ({ initCapture }));
      // Boot module reads SOFTPROBE_MODE and calls initCapture in CAPTURE mode
      require('../init');
      expect(initCapture).toHaveBeenCalledTimes(1);
    });
  });

  it('requires module without throwing when SOFTPROBE_MODE=REPLAY', () => {
    process.env.SOFTPROBE_MODE = 'REPLAY';

    jest.isolateModules(() => {
      expect(() => require('../init')).not.toThrow();
    });
  });
});
