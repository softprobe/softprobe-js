/**
 * Debug: does SoftprobeContext.getMode() return REPLAY inside run() when the SDK is started?
 * Run from repo root: npx ts-node --transpile-only -r ./src/init scripts/debug-replay-context.ts
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
sdk.start();

import { SoftprobeContext } from '../src/context';
console.log('mode before run():', SoftprobeContext.getMode());

const redis = require('redis');

async function test() {
  await SoftprobeContext.run(
    { mode: 'REPLAY', traceId: 'softprobe-test', cassetteDirectory: 'examples/basic-app' },
    async () => {
      console.log('mode inside run():', SoftprobeContext.getMode());
      const client = redis.createClient({ url: 'redis://localhost:6379' });
      try {
        await client.connect();
        console.log('connect() returned (GOOD — no-op in REPLAY mode)');
        await client.quit();
      } catch (e: unknown) {
        const err = e as { constructor: { name: string }; message?: string };
        console.log('connect() threw:', err.constructor.name, err.message || '(no message)');
      }
    }
  );
}

test()
  .catch(console.error)
  .finally(() => sdk.shutdown().catch(() => {}));
