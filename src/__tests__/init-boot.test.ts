/**
 * Task 11.1.1: softprobe/init reads SOFTPROBE_MODE.
 * Test: requires module under REPLAY/CAPTURE modes.
 */

describe('softprobe/init boot', () => {
  const originalMode = process.env.SOFTPROBE_MODE;
  const originalCassettePath = process.env.SOFTPROBE_CASSETTE_PATH;

  afterEach(() => {
    if (originalMode !== undefined) process.env.SOFTPROBE_MODE = originalMode;
    else delete process.env.SOFTPROBE_MODE;
    if (originalCassettePath !== undefined) process.env.SOFTPROBE_CASSETTE_PATH = originalCassettePath;
    else delete process.env.SOFTPROBE_CASSETTE_PATH;
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

  it('sets capture cassette store when SOFTPROBE_MODE=CAPTURE and cassette path is set', () => {
    const initCapture = jest.fn();
    const setCaptureStore = jest.fn();
    const fakeStore = { flushOnExit: jest.fn() };
    const CassetteStore = jest.fn(() => fakeStore);
    process.env.SOFTPROBE_MODE = 'CAPTURE';
    process.env.SOFTPROBE_CASSETTE_PATH = '/tmp/capture.ndjson';

    jest.isolateModules(() => {
      jest.doMock('../capture/init', () => ({ initCapture }));
      jest.doMock('../capture/store-accessor', () => ({ setCaptureStore }));
      jest.doMock('../store/cassette-store', () => ({ CassetteStore }));
      require('../init');
      expect(initCapture).toHaveBeenCalledTimes(1);
      expect(CassetteStore).toHaveBeenCalledWith('/tmp/capture.ndjson');
      expect(setCaptureStore).toHaveBeenCalledWith(fakeStore);
    });
  });

  it('requires module without throwing when SOFTPROBE_MODE=REPLAY', () => {
    process.env.SOFTPROBE_MODE = 'REPLAY';

    jest.isolateModules(() => {
      expect(() => require('../init')).not.toThrow();
    });
  });

  /**
   * Task 11.1.2: REPLAY mode loads cassette synchronously (or eagerly).
   * Test: load called exactly once.
   */
  it('calls load exactly once when SOFTPROBE_MODE=REPLAY and cassette path is set', () => {
    const loadNdjson = jest.fn().mockResolvedValue([]);
    process.env.SOFTPROBE_MODE = 'REPLAY';
    process.env.SOFTPROBE_CASSETTE_PATH = '/tmp/cassette.ndjson';

    jest.isolateModules(() => {
      jest.doMock('../store/load-ndjson', () => ({ loadNdjson }));
      require('../init');
      expect(loadNdjson).toHaveBeenCalledTimes(1);
      expect(loadNdjson).toHaveBeenCalledWith('/tmp/cassette.ndjson');
    });
  });

  /**
   * Task 11.1.3: Applies adapter patches synchronously.
   * Test: patch fns called during module import.
   */
  it('calls replay adapter patch fns during import when SOFTPROBE_MODE=REPLAY', () => {
    const setupPostgresReplay = jest.fn();
    const setupRedisReplay = jest.fn();
    const setupUndiciReplay = jest.fn();
    const setupHttpReplayInterceptor = jest.fn();
    process.env.SOFTPROBE_MODE = 'REPLAY';

    jest.isolateModules(() => {
      jest.doMock('../replay/postgres', () => ({ setupPostgresReplay }));
      jest.doMock('../replay/redis', () => ({ setupRedisReplay }));
      jest.doMock('../replay/undici', () => ({ setupUndiciReplay }));
      jest.doMock('../replay/http', () => ({ setupHttpReplayInterceptor }));
      require('../init');
      expect(setupPostgresReplay).toHaveBeenCalledTimes(1);
      expect(setupRedisReplay).toHaveBeenCalledTimes(1);
      expect(setupUndiciReplay).toHaveBeenCalledTimes(1);
      expect(setupHttpReplayInterceptor).toHaveBeenCalledTimes(1);
    });
  });
});
