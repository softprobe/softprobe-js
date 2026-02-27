/**
 * Debug: in an actual Express server with OTel, does SoftprobeContext.getMode()
 * return REPLAY inside a route handler when the request has x-softprobe-mode: REPLAY?
 * Run: npx ts-node --transpile-only -r ./src/init scripts/debug-express-replay.ts
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
sdk.start();

import { SoftprobeContext } from '../src/context';

process.chdir('examples/basic-app');

const express = require('express') as typeof import('express');
const app = express();

app.get('/test', async (_req: any, res: any) => {
  const mode = SoftprobeContext.getMode();
  console.log('mode in route handler:', mode);

  const { createClient } = require('redis');
  const client = createClient({ url: 'redis://localhost:6379' });
  try {
    await client.connect();
    console.log('connect() = no-op ✓ (REPLAY intercepted)');
    await client.quit();
  } catch (e: unknown) {
    const err = e as { constructor: { name: string }; message?: string };
    console.log('connect() threw:', err.constructor.name, err.message?.slice(0, 80) ?? '');
  }
  res.json({ mode });
});

const server = app.listen(3099, async () => {
  console.log('server started on 3099');
  try {
    const resp = await fetch('http://127.0.0.1:3099/test', {
      headers: {
        'x-softprobe-mode': 'REPLAY',
        'x-softprobe-trace-id': 'softprobe-test',
      },
    });
    const body = await resp.json() as unknown;
    console.log('response body:', JSON.stringify(body));
  } catch (e) {
    console.error('fetch failed:', e);
  } finally {
    server.close();
    try { await sdk.shutdown(); } catch {}
  }
});
