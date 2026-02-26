/**
 * Task 12.4.1: Child worker for HTTP NDJSON cassette capture E2E.
 * Env: SOFTPROBE_CONFIG_PATH, CAPTURE_URL
 * Stdout: JSON { url, status, body }
 */

import '../../../init';
import { getCaptureStore } from '../../../capture/store-accessor';

async function main(): Promise<void> {
  const url = process.env.CAPTURE_URL;
  if (!url) throw new Error('CAPTURE_URL is required');

  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
  sdk.start();

  const applyHttpReplay = (globalThis as unknown as { __softprobeApplyHttpReplay?: () => unknown })
    .__softprobeApplyHttpReplay;
  if (typeof applyHttpReplay === 'function') {
    applyHttpReplay();
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const body = await response.text();
  const statusCode = response.status;

  const store = getCaptureStore();
  if (!store) throw new Error('Capture store is not initialized');
  await store.flushOnExit();
  try {
    await sdk.shutdown();
  } catch {
    /* ignore */
  }

  process.stdout.write(JSON.stringify({ url, status: statusCode, body }));
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write((err instanceof Error ? err.stack : String(err)) ?? '');
  process.exit(1);
});
