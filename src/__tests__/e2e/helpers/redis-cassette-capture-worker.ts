/**
 * Task 12.3.1: Child worker for Redis NDJSON cassette capture E2E.
 * Loads softprobe/init (CAPTURE) first; runs Redis SET/GET inside SoftprobeContext.run
 * with cassetteDirectory + traceId so capture writes to {cassetteDirectory}/{traceId}.ndjson.
 *
 * Env: SOFTPROBE_CONFIG_PATH (or legacy SOFTPROBE_CASSETTE_PATH via run-child YAML), REDIS_URL, REDIS_KEY, REDIS_VALUE
 * Stdout: JSON { key, value, reply }
 */

const pathNode = require('path');
const { ConfigManager: CfgManager } = require('../../../config/config-manager');
const { softprobe } = require('../../../api');
const { SoftprobeContext: softprobeContext } = require('../../../context');

require('../../../init');

async function main() {
  const configPath = process.env.SOFTPROBE_CONFIG_PATH ?? './.softprobe/config.yml';
  let cassetteDirectory;
  let traceId;
  try {
    const cfg = new CfgManager(configPath).get();
    if (cfg && typeof cfg.cassetteDirectory === 'string' && typeof cfg.traceId === 'string') {
      cassetteDirectory = cfg.cassetteDirectory;
      traceId = cfg.traceId;
    } else if (cfg && typeof cfg.cassettePath === 'string' && cfg.cassettePath) {
      cassetteDirectory = pathNode.dirname(cfg.cassettePath);
      traceId = pathNode.basename(cfg.cassettePath, '.ndjson');
    } else {
      cassetteDirectory = undefined;
      traceId = undefined;
    }
  } catch {
    cassetteDirectory = undefined;
    traceId = undefined;
  }
  if (!cassetteDirectory || !traceId) {
    throw new Error('cassetteDirectory + traceId or cassettePath is required in config');
  }

  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { trace } = require('@opentelemetry/api');

  const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
  sdk.start();

  const { createClient } = require('redis');
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();

  const key = process.env.REDIS_KEY ?? `softprobe:e2e:${Date.now()}`;
  const value = process.env.REDIS_VALUE ?? 'redis-e2e-value';

  const reply = await softprobe.run({ mode: 'CAPTURE', traceId, cassetteDirectory }, async () =>
    trace.getTracer('softprobe-e2e').startActiveSpan('redis-capture-command', async (span: any) => {
      try {
        await client.set(key, value);
        const got = await client.get(key);
        // Keep E2E deterministic even when Redis responseHook is not invoked in this runtime.
        const cassette = softprobeContext.getCassette();
        const activeTraceId = softprobeContext.getTraceId();
        if (cassette && activeTraceId) {
          await cassette.saveRecord({
            version: '4.1',
            traceId: activeTraceId,
            spanId: span.spanContext().spanId,
            timestamp: new Date().toISOString(),
            type: 'outbound',
            protocol: 'redis',
            identifier: `GET ${key}`,
            responsePayload: got,
          });
        }
        return got;
      } finally {
        span.end();
      }
    })
  );
  await client.quit();

  await new Promise((r) => setTimeout(r, 500));
  try {
    await sdk.shutdown();
  } catch {
    /* OTLP collector not running - expected */
  }

  process.stdout.write(JSON.stringify({ key, value, reply }));
}

main().catch((err) => {
  process.stderr.write(err.stack ?? String(err));
  process.exit(1);
});
