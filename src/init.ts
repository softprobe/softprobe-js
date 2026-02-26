/**
 * Boot entry: softprobe/init.
 * Must be imported first (before OTel). Reads config from .softprobe/config.yml
 * (or SOFTPROBE_CONFIG_PATH) and runs CAPTURE or REPLAY init accordingly; design §4.1, §11.
 * No SOFTPROBE_MODE / SOFTPROBE_CASSETTE_PATH; mode and cassettePath come from config only.
 */

const { ConfigManager } = require('./config/config-manager');
const { SoftprobeContext } = require('./context');
const { NdjsonCassette } = require('./core/cassette/ndjson-cassette');

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
  SoftprobeContext.initGlobal({
    mode: g.mode,
    cassettePath: g.cassettePath,
    storage: g.cassettePath ? new NdjsonCassette(g.cassettePath) : undefined,
    strictReplay: g.replay?.strictReplay,
    strictComparison: g.replay?.strictComparison,
  });
  mode = (g.mode as string) ?? 'PASSTHROUGH';
  cassettePath = (g.cassettePath as string) ?? '';
} catch {
  // No config file (e.g. E2E child or examples): fall back to env so callers can pass mode/cassettePath.
  const envMode = process.env.SOFTPROBE_MODE ?? 'PASSTHROUGH';
  const envPath = process.env.SOFTPROBE_CASSETTE_PATH ?? '';
  SoftprobeContext.initGlobal({
    mode: envMode,
    cassettePath: envPath,
    storage: envPath ? new NdjsonCassette(envPath) : undefined,
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
  const { setupHttpReplayInterceptor } = require('./replay/http');

  initCapture();

  const outPath = cassettePath || './softprobe-cassettes.ndjson';
  const store = new CassetteStore(outPath);
  setCaptureStore(store);
  process.on('beforeExit', () => store.flushOnExit());

  applyAutoInstrumentationMutator();
  applyFrameworkMutators();
  // Plan: same HTTP interceptor as REPLAY; app must call __softprobeApplyHttpReplay() after sdk.start() so CAPTURE branch (bypass fetch + tap) runs.
  (globalThis as unknown as { __softprobeApplyHttpReplay?: () => void }).__softprobeApplyHttpReplay = setupHttpReplayInterceptor;
}

// Task 16.2.1: When PASSTHROUGH, enable capture via headers (x-softprobe-mode: CAPTURE + x-softprobe-cassette-path).
// Also apply replay patches (undici, pg, redis) so replay works via headers (x-softprobe-mode: REPLAY + x-softprobe-cassette-path);
// middleware loads cassette on demand; no SOFTPROBE_MODE=REPLAY required at boot.
if (mode === 'PASSTHROUGH') {
  const { initCapture } = require('./capture/init');
  const { setCaptureStore } = require('./capture/store-accessor');
  const { contextRoutingCaptureStore } = require('./store/context-routing-capture-store');
  const { applyAutoInstrumentationMutator } = require('./capture/mutator');
  const { applyFrameworkMutators } = require('./capture/framework-mutator');
  const { setupHttpReplayInterceptor } = require('./replay/http');
  const { setupPostgresReplay } = require('./replay/postgres');
  const { setupRedisReplay } = require('./replay/redis');
  const { setupUndiciReplay } = require('./replay/undici');

  initCapture();
  setCaptureStore(contextRoutingCaptureStore);
  process.on('beforeExit', () => contextRoutingCaptureStore.flushOnExit());

  applyAutoInstrumentationMutator();
  applyFrameworkMutators();
  // Replay patches so requests with REPLAY headers get mocked (middleware loads cassette on demand).
  setupPostgresReplay();
  setupRedisReplay();
  setupUndiciReplay();
  (globalThis as unknown as { __softprobeApplyHttpReplay?: () => void }).__softprobeApplyHttpReplay = setupHttpReplayInterceptor;
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
  applyFrameworkMutators();
  // Instrumentation must call __softprobeApplyHttpReplay() after sdk.start() so our fetch patch runs after OTel and stays on top.
  (globalThis as unknown as { __softprobeApplyHttpReplay?: () => void }).__softprobeApplyHttpReplay = setupHttpReplayInterceptor;
}
