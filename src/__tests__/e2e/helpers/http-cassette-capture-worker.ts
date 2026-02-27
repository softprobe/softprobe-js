/**
 * Task 12.4.1: Child worker for HTTP NDJSON cassette capture E2E.
 * Env: SOFTPROBE_CONFIG_PATH, CAPTURE_URL
 * Stdout: JSON { url, status, body }
 * Task 13.10: Runs fetch inside SoftprobeContext.run with cassetteDirectory.
 * Background flusher handles flush; direct write needs no explicit flush.
 */

import path from 'path';
import '../../../init';
import { ConfigManager } from '../../../config/config-manager';
import { softprobe } from '../../../api';

async function main(): Promise<void> {
  const url = process.env.CAPTURE_URL;
  if (!url) throw new Error('CAPTURE_URL is required');

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
  if (!cassetteDirectory || !traceId) {
    throw new Error('cassetteDirectory + traceId or cassettePath is required in config');
  }

  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
  sdk.start();

  const result = await softprobe.run(
    { mode: 'CAPTURE', traceId, cassetteDirectory },
    async () => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'x-softprobe-probe': '1' },
      });
      const body = await response.text();
      const statusCode = response.status;
      const hasLegacyModeEnv = typeof process.env.SOFTPROBE_MODE === 'string' && process.env.SOFTPROBE_MODE.length > 0;
      const hasLegacyCassetteEnv =
        typeof process.env.SOFTPROBE_CASSETTE_PATH === 'string' &&
        process.env.SOFTPROBE_CASSETTE_PATH.length > 0;
      return { url, statusCode, body, hasLegacyModeEnv, hasLegacyCassetteEnv };
    }
  );

  try {
    await sdk.shutdown();
  } catch {
    /* ignore */
  }

  process.stdout.write(
    JSON.stringify({
      url: result.url,
      status: result.statusCode,
      body: result.body,
      hasLegacyModeEnv: result.hasLegacyModeEnv,
      hasLegacyCassetteEnv: result.hasLegacyCassetteEnv,
    })
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write((err instanceof Error ? err.stack : String(err)) ?? '');
  process.exit(1);
});
