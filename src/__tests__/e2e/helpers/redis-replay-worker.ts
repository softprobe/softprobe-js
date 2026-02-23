/**
 * Task 12.3.2: Child worker for Redis replay E2E.
 * Loads softprobe/init (REPLAY) first, then runs Redis GET under
 * softprobe.runWithContext({ cassettePath }).
 *
 * Env: SOFTPROBE_MODE=REPLAY, SOFTPROBE_CASSETTE_PATH, REDIS_KEY
 * Stdout: JSON { value }
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

require('../../../init');

async function main() {
  const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
  sdk.start();

  const { softprobe } = require('../../../api');
  const { createClient } = require('redis');

  const key = process.env.REDIS_KEY;
  const cassettePath = process.env.SOFTPROBE_CASSETTE_PATH;
  if (!key) throw new Error('REDIS_KEY is required');
  if (!cassettePath) throw new Error('SOFTPROBE_CASSETTE_PATH is required');

  // Intentionally do not connect to a live Redis server.
  const client = createClient({ url: 'redis://127.0.0.1:6399' });

  const value = await softprobe.runWithContext({ cassettePath }, async () => {
    const matcher = softprobe.getActiveMatcher();
    if (matcher && typeof matcher.use === 'function') {
      matcher.use((_span: unknown, records: Array<{
        type: string;
        protocol: string;
        identifier: string;
        responsePayload?: unknown;
      }>) => {
        const rec = records.find(
          (r) =>
            r.type === 'outbound' &&
            r.protocol === 'redis' &&
            r.identifier === `GET ${key}`
        );
        return rec
          ? { action: 'MOCK' as const, payload: rec.responsePayload }
          : { action: 'CONTINUE' as const };
      });
    }
    return client.get(key);
  });

  try {
    client.destroy();
  } catch {
    // no-op
  }

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
