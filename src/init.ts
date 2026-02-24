/**
 * Boot entry: softprobe/init.
 * Must be imported first (before OTel). Reads config from .softprobe/config.yml
 * (or SOFTPROBE_CONFIG_PATH) and runs CAPTURE or REPLAY init accordingly; design §4.1, §11.
 * No SOFTPROBE_MODE / SOFTPROBE_CASSETTE_PATH; mode and cassettePath come from config only.
 */

const { ConfigManager } = require('./config/config-manager');
const { initGlobalContext } = require('./context');

let mode: string = 'PASSTHROUGH';
let cassettePath: string = '';

const configPath = process.env.SOFTPROBE_CONFIG_PATH ?? './.softprobe/config.yml';
try {
  const mgr = new ConfigManager(configPath);
  const g = mgr.get() as {
    mode?: string;
    cassettePath?: string;
    replay?: { strictReplay?: boolean; strictComparison?: boolean };
  };
  initGlobalContext({
    mode: g.mode,
    cassettePath: g.cassettePath,
    strictReplay: g.replay?.strictReplay,
    strictComparison: g.replay?.strictComparison,
  });
  mode = (g.mode as string) ?? 'PASSTHROUGH';
  cassettePath = (g.cassettePath as string) ?? '';
} catch {
  // No config file (e.g. E2E child or examples): fall back to env so callers can pass mode/cassettePath.
  const envMode = process.env.SOFTPROBE_MODE ?? 'PASSTHROUGH';
  const envPath = process.env.SOFTPROBE_CASSETTE_PATH ?? '';
  initGlobalContext({
    mode: envMode,
    cassettePath: envPath,
    strictReplay: process.env.SOFTPROBE_STRICT_REPLAY === '1',
    strictComparison: process.env.SOFTPROBE_STRICT_COMPARISON === '1',
  });
  mode = envMode;
  cassettePath = envPath;
}

if (mode === 'CAPTURE') {
  const { initCapture } = require('./capture/init');
  const { setCaptureStore } = require('./capture/store-accessor');
  const { CassetteStore } = require('./store/cassette-store');
  const { applyAutoInstrumentationMutator } = require('./capture/mutator');
  const { applyFrameworkMutators } = require('./capture/framework-mutator');

  initCapture();

  const outPath = cassettePath || './softprobe-cassettes.ndjson';
  const store = new CassetteStore(outPath);
  setCaptureStore(store);
  process.on('beforeExit', () => store.flushOnExit());

  applyAutoInstrumentationMutator();
  applyFrameworkMutators();
}

if (mode === 'REPLAY') {
  if (cassettePath) {
    const { loadNdjson } = require('./store/load-ndjson');
    loadNdjson(cassettePath); // eager load, called exactly once (task 11.1.2)
  }
  // Patch pg/redis when first required by any module so example app and E2E use the same patched instance (Task 16.3.1).
  const { applyPostgresReplay } = require('./replay/postgres');
  const Module = require('module');
  const origRequire = Module.prototype.require;
  const { applyRedisReplay } = require('./replay/redis');
  Module.prototype.require = function (id: string) {
    const m = origRequire.apply(this, arguments as unknown as [string]);
    if (id === 'pg' && m && m.Client) {
      applyPostgresReplay(m);
    }
    if (id === 'redis' && m) {
      applyRedisReplay(m);
    }
    return m;
  };
  // Apply adapter patches; setupPostgresReplay/setupRedisReplay trigger require so the hook runs (task 11.1.3).
  const { setupPostgresReplay } = require('./replay/postgres');
  const { setupRedisReplay } = require('./replay/redis');
  const { setupUndiciReplay } = require('./replay/undici');
  const { setupHttpReplayInterceptor } = require('./replay/http');
  const { applyFrameworkMutators } = require('./capture/framework-mutator');
  setupPostgresReplay();
  setupRedisReplay();
  setupUndiciReplay();
  setupHttpReplayInterceptor();
  applyFrameworkMutators();
}
