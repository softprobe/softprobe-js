/**
 * Boot entry: softprobe/init.
 * Must be imported first (before OTel). Reads SOFTPROBE_MODE and runs
 * CAPTURE or REPLAY init accordingly; design §4.1, §11.
 */

const mode = process.env.SOFTPROBE_MODE;

if (mode === 'CAPTURE') {
  const { initCapture } = require('./capture/init');
  const { setCaptureStore } = require('./capture/store-accessor');
  const { CassetteStore } = require('./store/cassette-store');
  const { applyAutoInstrumentationMutator } = require('./capture/mutator');
  const { applyFrameworkMutators } = require('./capture/framework-mutator');

  initCapture();

  const outPath =
    process.env.SOFTPROBE_CASSETTE_PATH ?? './softprobe-cassettes.ndjson';
  const store = new CassetteStore(outPath);
  setCaptureStore(store);
  process.on('beforeExit', () => store.flushOnExit());

  applyAutoInstrumentationMutator();
  applyFrameworkMutators();
}

if (mode === 'REPLAY') {
  const path = process.env.SOFTPROBE_CASSETTE_PATH;
  if (path) {
    const { loadNdjson } = require('./store/load-ndjson');
    loadNdjson(path); // eager load, called exactly once (task 11.1.2)
  }
  // Apply adapter patches synchronously so drivers are wrapped before use (task 11.1.3)
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
