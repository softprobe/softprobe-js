/**
 * Child-process worker for Redis E2E capture.
 * Runs outside Jest so OTel require-in-the-middle hooks can instrument redis.
 *
 * Env:   REDIS_URL, SOFTPROBE_TRACES_FILE, REDIS_KEY
 * Stdout: JSON with { key, value, reply } from the test commands.
 *
 * Note: OTEL_TRACES_EXPORTER must NOT be "none" — that disables span
 * recording entirely, preventing any exporter (including ours) from seeing spans.
 */

import { initCapture } from '../../../capture/init';
import { applyAutoInstrumentationMutator } from '../../../capture/mutator';

initCapture();
applyAutoInstrumentationMutator();

async function main() {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

  const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
  sdk.start();

  const { createClient } = require('redis');
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();

  const key = process.env.REDIS_KEY ?? `softprobe:e2e:${Date.now()}`;
  const value = 'redis-e2e-value';
  await client.set(key, value);
  const reply = await client.get(key);
  await client.quit();

  await new Promise((r) => setTimeout(r, 1000));
  try { await sdk.shutdown(); } catch { /* OTLP collector not running — expected */ }

  process.stdout.write(JSON.stringify({ key, value, reply }));
}

main().catch((err) => {
  process.stderr.write(err.stack ?? String(err));
  process.exit(1);
});
