/**
 * Task 12.3.2: Child worker for Redis replay E2E.
 * Loads softprobe/init (REPLAY) first, then runs Redis GET under softprobe.run(REPLAY).
 *
 * Env: SOFTPROBE_CONFIG_PATH, REDIS_KEY, REPLAY_TRACE_ID
 * Stdout: JSON { value }
 */

import path from 'path';
import '../../../init';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { trace } from '@opentelemetry/api';
import { ConfigManager } from '../../../config/config-manager';
import { softprobe } from '../../../api';

async function main() {
  const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
  sdk.start();

  const { createClient } = require('redis');

  const key = process.env.REDIS_KEY;
  const replayTraceId =
    process.env.REPLAY_TRACE_ID !== undefined
      ? process.env.REPLAY_TRACE_ID
      : 'redis-e2e-replay';
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
  if (!key) throw new Error('REDIS_KEY is required');
  if (!cassetteDirectory || !traceId) {
    throw new Error('cassetteDirectory + traceId or cassettePath is required in config');
  }

  // Intentionally do not connect to a live Redis server.
  const client = createClient({ url: 'redis://127.0.0.1:6399' });

  const value = await softprobe.run(
    {
      mode: 'REPLAY',
      traceId,
      cassetteDirectory,
    },
    async () =>
      trace.getTracer('softprobe-e2e').startActiveSpan('redis-replay-command', async (span) => {
        try {
          return await client.get(key);
        } finally {
          span.end();
        }
      })
  );

  try {
    await sdk.shutdown();
  } catch {
    // no-op
  }

  process.stdout.write(JSON.stringify({ value }));
}

main().catch((err) => {
  process.stderr.write(err.stack ?? String(err));
  process.exit(1);
});
