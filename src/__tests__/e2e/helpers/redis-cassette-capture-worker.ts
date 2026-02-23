/**
 * Task 12.3.1: Child worker for Redis NDJSON cassette capture E2E.
 * Loads softprobe/init (CAPTURE) first so capture hooks are active,
 * then executes SET/GET against Redis.
 *
 * Env: SOFTPROBE_MODE=CAPTURE, SOFTPROBE_CASSETTE_PATH, REDIS_URL, REDIS_KEY, REDIS_VALUE
 * Stdout: JSON { key, value, reply }
 */

require('../../../init');

async function main() {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

  const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
  sdk.start();

  const { createClient } = require('redis');
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();

  const key = process.env.REDIS_KEY ?? `softprobe:e2e:${Date.now()}`;
  const value = process.env.REDIS_VALUE ?? 'redis-e2e-value';

  await client.set(key, value);
  const reply = await client.get(key);
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
