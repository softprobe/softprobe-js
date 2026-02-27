/**
 * Boot tests for softprobe/init using config-driven mode/cassette setup.
 */

describe('softprobe/init boot', () => {
  const originalConfigPath = process.env.SOFTPROBE_CONFIG_PATH;

  afterEach(() => {
    if (originalConfigPath !== undefined) process.env.SOFTPROBE_CONFIG_PATH = originalConfigPath;
    else delete process.env.SOFTPROBE_CONFIG_PATH;
  });

  it('runs capture boot wiring when config mode is CAPTURE (Task 13.2: no global cassette)', () => {
    const setCaptureStore = jest.fn();
    const CassetteStore = jest.fn(() => ({ flushOnExit: jest.fn() }));
    const applyAutoInstrumentationMutator = jest.fn();
    const applyFrameworkMutators = jest.fn();
    const setupHttpReplayInterceptor = jest.fn();
    jest.isolateModules(() => {
      jest.doMock('../config/config-manager', () => ({
        ConfigManager: class {
          get() {
            return { mode: 'CAPTURE', cassettePath: '/tmp/capture.ndjson' };
          }
        },
      }));
      jest.doMock('../capture/store-accessor', () => ({ setCaptureStore }));
      jest.doMock('../store/cassette-store', () => ({ CassetteStore }));
      jest.doMock('../capture/mutator', () => ({ applyAutoInstrumentationMutator }));
      jest.doMock('../capture/framework-mutator', () => ({ applyFrameworkMutators }));
      jest.doMock('../replay/http', () => ({ setupHttpReplayInterceptor }));
      require('../init');
      expect(CassetteStore).not.toHaveBeenCalled();
      expect(setCaptureStore).not.toHaveBeenCalled();
      expect(applyAutoInstrumentationMutator).toHaveBeenCalledTimes(1);
      expect(applyFrameworkMutators).toHaveBeenCalledTimes(1);
      expect(setupHttpReplayInterceptor).toHaveBeenCalledTimes(1);
    });
  });

  it('does not set global capture store when config mode is CAPTURE (Task 13.2)', () => {
    const setCaptureStore = jest.fn();
    const CassetteStore = jest.fn(() => ({ flushOnExit: jest.fn() }));

    jest.isolateModules(() => {
      jest.doMock('../config/config-manager', () => ({
        ConfigManager: class {
          get() {
            return { mode: 'CAPTURE', cassettePath: '/tmp/capture.ndjson' };
          }
        },
      }));
      jest.doMock('../capture/store-accessor', () => ({ setCaptureStore }));
      jest.doMock('../store/cassette-store', () => ({ CassetteStore }));
      jest.doMock('../capture/mutator', () => ({ applyAutoInstrumentationMutator: jest.fn() }));
      jest.doMock('../capture/framework-mutator', () => ({ applyFrameworkMutators: jest.fn() }));
      jest.doMock('../replay/http', () => ({ setupHttpReplayInterceptor: jest.fn() }));
      require('../init');
      expect(CassetteStore).not.toHaveBeenCalled();
      expect(setCaptureStore).not.toHaveBeenCalled();
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

  it('does not eager-load cassette when config mode is REPLAY (Task 13.2: no global cassette)', () => {
    jest.isolateModules(() => {
      jest.doMock('../config/config-manager', () => ({
        ConfigManager: class {
          get() {
            return { mode: 'REPLAY', cassettePath: '/tmp/cassette.ndjson' };
          }
        },
      }));
      jest.doMock('../capture/mutator', () => ({ applyAutoInstrumentationMutator: jest.fn() }));
      jest.doMock('../replay/postgres', () => ({ setupPostgresReplay: jest.fn(), applyPostgresReplay: jest.fn() }));
      jest.doMock('../replay/redis', () => ({ setupRedisReplay: jest.fn(), applyRedisReplay: jest.fn() }));
      jest.doMock('../replay/http', () => ({ setupHttpReplayInterceptor: jest.fn() }));
      jest.doMock('../capture/framework-mutator', () => ({ applyFrameworkMutators: jest.fn() }));
      require('../init');
    });
  });

  it('applies all replay patches during init (one-line init; HTTP via MSW only)', () => {
    const setupHttpReplayInterceptor = jest.fn();
    const setupPostgresReplay = jest.fn();
    const setupRedisReplay = jest.fn();
    const applyRedisReplay = jest.fn();

    jest.isolateModules(() => {
      jest.doMock('../config/config-manager', () => ({
        ConfigManager: class {
          get() {
            return { mode: 'REPLAY', cassettePath: '/tmp/cassette.ndjson' };
          }
        },
      }));
      jest.doMock('../capture/mutator', () => ({ applyAutoInstrumentationMutator: jest.fn() }));
      jest.doMock('../replay/postgres', () => ({ setupPostgresReplay, applyPostgresReplay: jest.fn() }));
      jest.doMock('../replay/redis', () => ({ setupRedisReplay, applyRedisReplay }));
      jest.doMock('../replay/http', () => ({ setupHttpReplayInterceptor }));
      jest.doMock('../capture/framework-mutator', () => ({ applyFrameworkMutators: jest.fn() }));
      require('../init');
      expect(setupHttpReplayInterceptor).toHaveBeenCalledTimes(1);
      expect(setupPostgresReplay).toHaveBeenCalledTimes(1);
      expect(setupRedisReplay).toHaveBeenCalledTimes(1);
      expect(applyRedisReplay).toHaveBeenCalledTimes(1);
    });
  });

  it('Task 13.2: init does not construct NdjsonCassette at boot (was Task 8.1)', () => {
    const initGlobal = jest.fn();
    const NdjsonCassette = jest.fn(() => ({ loadTrace: jest.fn(), saveRecord: jest.fn() }));

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
      jest.doMock('../replay/postgres', () => ({ setupPostgresReplay: jest.fn(), applyPostgresReplay: jest.fn() }));
      jest.doMock('../replay/redis', () => ({ setupRedisReplay: jest.fn(), applyRedisReplay: jest.fn() }));
      jest.doMock('../replay/http', () => ({ setupHttpReplayInterceptor: jest.fn() }));
      jest.doMock('../capture/framework-mutator', () => ({ applyFrameworkMutators: jest.fn() }));

      require('../init');
      expect(NdjsonCassette).not.toHaveBeenCalled();
      expect(initGlobal).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'REPLAY',
        cassetteDirectory: '/tmp',
      }));
      expect(initGlobal.mock.calls[0][0].cassettePath).toBeUndefined();
      expect(initGlobal.mock.calls[0][0].storage).toBeUndefined();
    });
  });

  it('Task 13.1: init with cassetteDirectory does not pass single file path for default cassette store', () => {
    const initGlobal = jest.fn();
    const NdjsonCassette = jest.fn();

    jest.isolateModules(() => {
      jest.doMock('../config/config-manager', () => ({
        ConfigManager: class {
          get() {
            return {
              mode: 'REPLAY',
              cassetteDirectory: '/var/cassettes',
              replay: { strictReplay: false, strictComparison: false },
            };
          }
        },
      }));
      jest.doMock('../context', () => ({
        SoftprobeContext: { initGlobal },
      }));
      jest.doMock('../core/cassette/ndjson-cassette', () => ({ NdjsonCassette }));
      jest.doMock('../replay/postgres', () => ({ setupPostgresReplay: jest.fn(), applyPostgresReplay: jest.fn() }));
      jest.doMock('../replay/redis', () => ({ setupRedisReplay: jest.fn(), applyRedisReplay: jest.fn() }));
      jest.doMock('../replay/http', () => ({ setupHttpReplayInterceptor: jest.fn() }));
      jest.doMock('../capture/framework-mutator', () => ({ applyFrameworkMutators: jest.fn() }));

      require('../init');
      expect(NdjsonCassette).not.toHaveBeenCalled();
      expect(initGlobal).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'REPLAY',
        cassetteDirectory: '/var/cassettes',
      }));
      expect(initGlobal.mock.calls[0][0].storage).toBeUndefined();
    });
  });

  it('Task 13.2: in CAPTURE, REPLAY, and PASSTHROUGH init does not create cassette or set global storage', () => {
    const NdjsonCassette = jest.fn();
    const setCaptureStore = jest.fn();
    const CassetteStore = jest.fn();

    const runInitForMode = (mode: string, cassetteDirectory?: string) => {
      NdjsonCassette.mockClear();
      setCaptureStore.mockClear();
      jest.isolateModules(() => {
        jest.doMock('../config/config-manager', () => ({
          ConfigManager: class {
            get() {
              return {
                mode,
                cassetteDirectory: cassetteDirectory ?? undefined,
                replay: { strictReplay: false, strictComparison: false },
              };
            }
          },
        }));
        jest.doMock('../core/cassette/ndjson-cassette', () => ({ NdjsonCassette }));
        jest.doMock('../capture/store-accessor', () => ({ setCaptureStore }));
        jest.doMock('../store/cassette-store', () => ({ CassetteStore }));
        jest.doMock('../capture/mutator', () => ({ applyAutoInstrumentationMutator: jest.fn() }));
        jest.doMock('../capture/framework-mutator', () => ({ applyFrameworkMutators: jest.fn() }));
        jest.doMock('../replay/http', () => ({ setupHttpReplayInterceptor: jest.fn() }));
        jest.doMock('../replay/postgres', () => ({ setupPostgresReplay: jest.fn(), applyPostgresReplay: jest.fn() }));
        jest.doMock('../replay/redis', () => ({ setupRedisReplay: jest.fn(), applyRedisReplay: jest.fn() }));
        require('../init');
      });
    };

    runInitForMode('CAPTURE', '/var/cassettes');
    expect(NdjsonCassette).not.toHaveBeenCalled();
    expect(setCaptureStore).not.toHaveBeenCalled();
    expect(CassetteStore).not.toHaveBeenCalled();

    runInitForMode('REPLAY', '/var/cassettes');
    expect(NdjsonCassette).not.toHaveBeenCalled();

    runInitForMode('PASSTHROUGH', '/var/cassettes');
    expect(NdjsonCassette).not.toHaveBeenCalled();
    expect(setCaptureStore).not.toHaveBeenCalled();
  });
});
