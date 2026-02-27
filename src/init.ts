/**
 * Boot entry: softprobe/init.
 * Must be imported first (before OTel). Reads config from .softprobe/config.yml
 * (or SOFTPROBE_CONFIG_PATH) and runs CAPTURE or REPLAY init accordingly; design §4.1, §11.
 * Mode and cassette location come from config only (cassetteDirectory or cassettePath; no env fallback).
 * Task 13.1: when cassetteDirectory is set, init does not create or pass a single-file cassette.
 */

const pathModule = require('path');
const { ConfigManager } = require('./config/config-manager');
const { SoftprobeContext } = require('./context');

let mode: string = 'PASSTHROUGH';

const configPath = process.env.SOFTPROBE_CONFIG_PATH ?? './.softprobe/config.yml';
try {
  const mgr = new ConfigManager(configPath);
  const g = mgr.get() as {
    mode?: string;
    cassettePath?: string;
    cassetteDirectory?: string;
    replay?: { strictReplay?: boolean; strictComparison?: boolean };
  };
  // Task 13.11: When config has cassettePath but no cassetteDirectory, derive directory for per-trace files.
  const cassetteDirectory =
    g.cassetteDirectory ??
    (typeof g.cassettePath === 'string' && g.cassettePath ? pathModule.dirname(g.cassettePath) : undefined);
  // Task 13.2: init never creates a Cassette or sets global storage; only mode, cassetteDirectory, strict flags.
  SoftprobeContext.initGlobal({
    mode: g.mode,
    cassetteDirectory,
    storage: undefined,
    strictReplay: g.replay?.strictReplay,
    strictComparison: g.replay?.strictComparison,
  });
  mode = (g.mode as string) ?? 'PASSTHROUGH';
} catch {
  // No config file: default to PASSTHROUGH with no cassette path.
  SoftprobeContext.initGlobal({
    mode: 'PASSTHROUGH',
    cassetteDirectory: undefined,
    storage: undefined,
    strictReplay: false,
    strictComparison: false,
  });
  mode = 'PASSTHROUGH';
}

if (mode === 'CAPTURE') {
  const { applyAutoInstrumentationMutator } = require('./capture/mutator');
  const { applyFrameworkMutators } = require('./capture/framework-mutator');
  const { setupHttpReplayInterceptor } = require('./replay/http');

  applyAutoInstrumentationMutator();
  applyFrameworkMutators();
  // Plan: same HTTP interceptor as REPLAY; app must call __softprobeApplyHttpReplay() after sdk.start() so CAPTURE branch (bypass fetch + tap) runs.
  (globalThis as unknown as { __softprobeApplyHttpReplay?: () => void }).__softprobeApplyHttpReplay = setupHttpReplayInterceptor;
}

// Task 16.2.1: When PASSTHROUGH, enable capture/replay via headers (x-softprobe-mode and x-softprobe-trace-id).
// Server must have cassetteDirectory set; cassette is resolved as {cassetteDirectory}/{traceId}.ndjson.
// Replay patches (undici, pg, redis) are applied so replay works; no SOFTPROBE_MODE=REPLAY required at boot.
// Task 13.2: no global cassette or setCaptureStore; capture/replay use context-created cassettes per request.
if (mode === 'PASSTHROUGH') {
  const { applyAutoInstrumentationMutator } = require('./capture/mutator');
  const { applyFrameworkMutators } = require('./capture/framework-mutator');
  const { setupHttpReplayInterceptor } = require('./replay/http');
  const { setupPostgresReplay } = require('./replay/postgres');
  const { setupRedisReplay } = require('./replay/redis');
  const { setupUndiciReplay } = require('./replay/undici');

  applyAutoInstrumentationMutator();
  applyFrameworkMutators();
  setupPostgresReplay();
  setupRedisReplay();
  setupUndiciReplay();
  (globalThis as unknown as { __softprobeApplyHttpReplay?: () => void }).__softprobeApplyHttpReplay = setupHttpReplayInterceptor;
}

if (mode === 'REPLAY') {
  // Task 13.2: no eager load of cassette file; replay loads per request via SoftprobeContext.
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
