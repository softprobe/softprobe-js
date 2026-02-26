/**
 * Task 13.1: Child worker for strict-replay E2E.
 * Env: SOFTPROBE_CONFIG_PATH, UNRECORDED_URL, REPLAY_TRACE_ID
 * Fetches UNRECORDED_URL (not in cassette) under softprobe.run(REPLAY); expects 500.
 * Stdout: JSON { status, body }
 */

import path from 'path';
import '../../../init';
import { softprobe } from '../../../api';
import { ConfigManager } from '../../../config/config-manager';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

async function main(): Promise<void> {
  const unrecordedUrl = process.env.UNRECORDED_URL;
  const configPath = process.env.SOFTPROBE_CONFIG_PATH ?? './.softprobe/config.yml';
  let cassettePath = '';
  try {
    cassettePath = new ConfigManager(configPath).get().cassettePath ?? '';
  } catch {
    cassettePath = '';
  }
  if (!unrecordedUrl) throw new Error('UNRECORDED_URL is required');
  if (!cassettePath) throw new Error('cassettePath is required in config');

  const cassetteDir = path.dirname(cassettePath);
  const traceId = path.basename(cassettePath, '.ndjson');

  const sdk = new NodeSDK({
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();

  await softprobe.run(
    {
      mode: 'REPLAY',
      traceId,
      cassetteDirectory: cassetteDir,
    },
    async () => {
      const undici = require('undici') as { fetch: typeof fetch };
      const response = await undici.fetch(unrecordedUrl);
      const body = await response.text();
      process.stdout.write(JSON.stringify({ status: response.status, body }));
    }
  );
  try {
    await sdk.shutdown();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write((err instanceof Error ? err.stack : String(err)) ?? '');
  process.exit(1);
});
