/**
 * Task 12.4.2: Child worker for HTTP replay E2E.
 * Env: SOFTPROBE_CONFIG_PATH, REPLAY_URL, REPLAY_TRACE_ID
 * Stdout: JSON { status, body }
 */

import path from 'path';
import '../../../init';
import { ConfigManager } from '../../../config/config-manager';
import { softprobe } from '../../../api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

async function main(): Promise<void> {
  const replayUrl = process.env.REPLAY_URL;
  const replayTraceId = process.env.REPLAY_TRACE_ID ?? 'http-e2e-replay';
  const configPath = process.env.SOFTPROBE_CONFIG_PATH ?? './.softprobe/config.yml';
  let cassetteDirectory: string | undefined;
  let traceId: string | undefined;
  try {
    const cfg = new ConfigManager(configPath).get() as {
      cassetteDirectory?: string;
      traceId?: string;
      cassettePath?: string;
    };
    cassetteDirectory = cfg.cassetteDirectory;
    traceId = cfg.traceId;
    if (!cassetteDirectory || !traceId) {
      const fromPath = cfg.cassettePath;
      if (typeof fromPath === 'string' && fromPath) {
        cassetteDirectory = path.dirname(fromPath);
        traceId = path.basename(fromPath, '.ndjson');
      }
    }
  } catch {
    cassetteDirectory = undefined;
    traceId = undefined;
  }
  if (!replayUrl) throw new Error('REPLAY_URL is required');
  if (!cassetteDirectory || !traceId) {
    throw new Error('cassetteDirectory + traceId or cassettePath is required in config');
  }

  const sdk = new NodeSDK({
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();

  await softprobe.run(
    {
      mode: 'REPLAY',
      traceId,
      cassetteDirectory,
    },
    async () => {
      const response = await fetch(replayUrl);
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
