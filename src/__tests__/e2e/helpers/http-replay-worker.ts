/**
 * Task 12.4.2: Child worker for HTTP replay E2E.
 * Env: SOFTPROBE_CONFIG_PATH, REPLAY_URL, REPLAY_TRACE_ID
 * Stdout: JSON { status, body }
 */

import '../../../init';
import { ConfigManager } from '../../../config/config-manager';
import { NdjsonCassette } from '../../../core/cassette/ndjson-cassette';
import { softprobe } from '../../../api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { applyUndiciFetchAsGlobal } from '../../../replay/undici';

async function main(): Promise<void> {
  const replayUrl = process.env.REPLAY_URL;
  const replayTraceId = process.env.REPLAY_TRACE_ID ?? 'http-e2e-replay';
  const configPath = process.env.SOFTPROBE_CONFIG_PATH ?? './.softprobe/config.yml';
  let cassettePath = '';
  try {
    const cfg = new ConfigManager(configPath).get();
    cassettePath = cfg.cassettePath ?? '';
  } catch {
    cassettePath = '';
  }
  if (!replayUrl) throw new Error('REPLAY_URL is required');
  if (!cassettePath) throw new Error('cassettePath is required in config');
  const storage = new NdjsonCassette(cassettePath);

  const sdk = new NodeSDK({
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
  applyUndiciFetchAsGlobal();

  await softprobe.run(
    {
      mode: 'REPLAY',
      traceId: replayTraceId,
      storage,
    },
    async () => {
      const undici = require('undici') as { fetch: typeof fetch };
      const response = await undici.fetch(replayUrl);
      const body = await response.text();
      const hasLegacyModeEnv =
        typeof process.env.SOFTPROBE_MODE === 'string' && process.env.SOFTPROBE_MODE.length > 0;
      const hasLegacyCassetteEnv =
        typeof process.env.SOFTPROBE_CASSETTE_PATH === 'string' &&
        process.env.SOFTPROBE_CASSETTE_PATH.length > 0;
      process.stdout.write(
        JSON.stringify({ status: response.status, body, hasLegacyModeEnv, hasLegacyCassetteEnv })
      );
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
