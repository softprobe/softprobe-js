/**
 * Boot entry: softprobe/init.
 * Must be imported first (before OTel). Reads config from .softprobe/config.yml
 * (or SOFTPROBE_CONFIG_PATH) and seeds global state. Design §4.1, §11.
 * Mode and cassette location come from config only (cassetteDirectory or cassettePath; no env fallback).
 * Task 13.1: when cassetteDirectory is set, init does not create or pass a single-file cassette.
 *
 * Instrumentation is always the same for all modes: mutators and replay patches are applied once.
 * Wrappers (pg, redis, http via MSW) take action at runtime based on SoftprobeContext.getMode().
 * All replay patches are applied here so the app only needs to load init before OTel (one-line init; design §4.1).
 */

const pathModule = require('path');
const { ConfigManager } = require('./config/config-manager');
const { SoftprobeContext } = require('./context');

const configPath = process.env.SOFTPROBE_CONFIG_PATH ?? './.softprobe/config.yml';
try {
  const mgr = new ConfigManager(configPath);
  const g = mgr.get() as {
    mode?: string;
    cassettePath?: string;
    cassetteDirectory?: string;
    replay?: { strictReplay?: boolean; strictComparison?: boolean };
  };
  const cassetteDirectory =
    g.cassetteDirectory ??
    (typeof g.cassettePath === 'string' && g.cassettePath ? pathModule.dirname(g.cassettePath) : undefined);
  SoftprobeContext.initGlobal({
    mode: g.mode,
    cassetteDirectory,
    storage: undefined,
    strictReplay: g.replay?.strictReplay,
    strictComparison: g.replay?.strictComparison,
  });
} catch {
  SoftprobeContext.initGlobal({
    mode: 'PASSTHROUGH',
    cassetteDirectory: undefined,
    storage: undefined,
    strictReplay: false,
    strictComparison: false,
  });
}

const { applyAutoInstrumentationMutator } = require('./capture/mutator');
const { applyFrameworkMutators } = require('./capture/framework-mutator');
const { setupHttpReplayInterceptor } = require('./instrumentations/fetch');
const { setupPostgresReplay } = require('./instrumentations/postgres');
const { setupRedisReplay, applyRedisReplay } = require('./instrumentations/redis');

applyAutoInstrumentationMutator();
applyFrameworkMutators();
// Redis: wrap attachCommands before redis is ever loaded (e.g. by OTel during sdk.start()).
setupRedisReplay();
setupHttpReplayInterceptor();
setupPostgresReplay();
applyRedisReplay(require('redis'));
