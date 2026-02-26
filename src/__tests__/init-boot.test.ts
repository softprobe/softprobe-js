/**
 * Boot tests for softprobe/init using config-driven mode/cassette setup.
 */

describe('softprobe/init boot', () => {
  const originalConfigPath = process.env.SOFTPROBE_CONFIG_PATH;

  afterEach(() => {
    if (originalConfigPath !== undefined) process.env.SOFTPROBE_CONFIG_PATH = originalConfigPath;
    else delete process.env.SOFTPROBE_CONFIG_PATH;
  });

  it('runs capture init when config mode is CAPTURE', () => {
    const initCapture = jest.fn();

    jest.isolateModules(() => {
      jest.doMock('../config/config-manager', () => ({
        ConfigManager: class {
          get() {
            return { mode: 'CAPTURE', cassettePath: '/tmp/capture.ndjson' };
          }
        },
      }));
      jest.doMock('../capture/init', () => ({ initCapture }));
      require('../init');
      expect(initCapture).toHaveBeenCalledTimes(1);
    });
  });

  it('sets capture cassette store when config mode is CAPTURE and cassette path is set', () => {
    const initCapture = jest.fn();
    const setCaptureStore = jest.fn();
    const fakeStore = { flushOnExit: jest.fn() };
    const CassetteStore = jest.fn(() => fakeStore);

    jest.isolateModules(() => {
      jest.doMock('../config/config-manager', () => ({
        ConfigManager: class {
          get() {
            return { mode: 'CAPTURE', cassettePath: '/tmp/capture.ndjson' };
          }
        },
      }));
      jest.doMock('../capture/init', () => ({ initCapture }));
      jest.doMock('../capture/store-accessor', () => ({ setCaptureStore }));
      jest.doMock('../store/cassette-store', () => ({ CassetteStore }));
      require('../init');
      expect(initCapture).toHaveBeenCalledTimes(1);
      expect(CassetteStore).toHaveBeenCalledWith('/tmp/capture.ndjson');
      expect(setCaptureStore).toHaveBeenCalledWith(fakeStore);
    });
  });

  it('requires module without throwing when config loading fails', () => {
    jest.isolateModules(() => {
      jest.doMock('../config/config-manager', () => ({
        ConfigManager: class {
          constructor() {
            throw new Error('missing config');
          }
        },
      }));
      expect(() => require('../init')).not.toThrow();
    });
  });

  it('calls load exactly once when config mode is REPLAY and cassette path is set', () => {
    const loadNdjson = jest.fn().mockResolvedValue([]);

    jest.isolateModules(() => {
      jest.doMock('../config/config-manager', () => ({
        ConfigManager: class {
          get() {
            return { mode: 'REPLAY', cassettePath: '/tmp/cassette.ndjson' };
          }
        },
      }));
      jest.doMock('../store/load-ndjson', () => ({ loadNdjson }));
      require('../init');
      expect(loadNdjson).toHaveBeenCalledTimes(1);
      expect(loadNdjson).toHaveBeenCalledWith('/tmp/cassette.ndjson');
    });
  });

  it('calls replay adapter patch fns during import when config mode is REPLAY', () => {
    const setupPostgresReplay = jest.fn();
    const setupRedisReplay = jest.fn();
    const setupUndiciReplay = jest.fn();
    const setupHttpReplayInterceptor = jest.fn();

    jest.isolateModules(() => {
      jest.doMock('../config/config-manager', () => ({
        ConfigManager: class {
          get() {
            return { mode: 'REPLAY', cassettePath: '/tmp/cassette.ndjson' };
          }
        },
      }));
      jest.doMock('../replay/postgres', () => ({ setupPostgresReplay, applyPostgresReplay: jest.fn() }));
      jest.doMock('../replay/redis', () => ({ setupRedisReplay, applyRedisReplay: jest.fn() }));
      jest.doMock('../replay/undici', () => ({ setupUndiciReplay }));
      jest.doMock('../replay/http', () => ({ setupHttpReplayInterceptor }));
      jest.doMock('../capture/framework-mutator', () => ({ applyFrameworkMutators: jest.fn() }));
      require('../init');
      expect(setupPostgresReplay).toHaveBeenCalledTimes(1);
      expect(setupRedisReplay).toHaveBeenCalledTimes(1);
      expect(setupUndiciReplay).toHaveBeenCalledTimes(1);
      expect((globalThis as unknown as { __softprobeApplyHttpReplay?: unknown }).__softprobeApplyHttpReplay).toBe(setupHttpReplayInterceptor);
    });
  });

  it('Task 8.1: constructs NdjsonCassette from configured NDJSON path at boot', () => {
    const initGlobal = jest.fn();
    const cassetteInstance = { loadTrace: jest.fn(), saveRecord: jest.fn() };
    const NdjsonCassette = jest.fn(() => cassetteInstance);
    const loadNdjson = jest.fn().mockResolvedValue([]);

    jest.isolateModules(() => {
      jest.doMock('../config/config-manager', () => ({
        ConfigManager: class {
          get() {
            return {
              mode: 'REPLAY',
              cassettePath: '/tmp/configured-cassette.ndjson',
            };
          }
        },
      }));
      jest.doMock('../context', () => ({
        SoftprobeContext: { initGlobal },
      }));
      jest.doMock('../core/cassette/ndjson-cassette', () => ({ NdjsonCassette }));
      jest.doMock('../store/load-ndjson', () => ({ loadNdjson }));
      jest.doMock('../replay/postgres', () => ({ setupPostgresReplay: jest.fn(), applyPostgresReplay: jest.fn() }));
      jest.doMock('../replay/redis', () => ({ setupRedisReplay: jest.fn(), applyRedisReplay: jest.fn() }));
      jest.doMock('../replay/undici', () => ({ setupUndiciReplay: jest.fn() }));
      jest.doMock('../replay/http', () => ({ setupHttpReplayInterceptor: jest.fn() }));
      jest.doMock('../capture/framework-mutator', () => ({ applyFrameworkMutators: jest.fn() }));

      require('../init');
      expect(NdjsonCassette).toHaveBeenCalledWith('/tmp/configured-cassette.ndjson');
      expect(initGlobal).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'REPLAY',
        cassettePath: '/tmp/configured-cassette.ndjson',
        storage: cassetteInstance,
      }));
    });
  });
});
