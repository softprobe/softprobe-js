/**
 * Debug: reproduce the exact example-app flow with instrumentation.ts
 * Run from repo root: npx ts-node --transpile-only -r ./src/init scripts/debug-express-replay2.ts
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
const sdk = new NodeSDK({ instrumentations: getNodeAutoInstrumentations() });
sdk.start();

import { SoftprobeContext } from '../src/context';

// Work from the example directory so cassette resolution matches.
process.chdir('examples/basic-app');

const express = require('express') as typeof import('express');
const app = express();

app.get('/test', async (_req: any, res: any) => {
  console.log('[handler] mode at handler entry:', SoftprobeContext.getMode());

  const { createClient } = require('redis');
  const client = createClient({ url: 'redis://localhost:6379' });
  console.log('[handler] client.connect is own prop?', Object.prototype.hasOwnProperty.call(client, 'connect'));
  console.log('[handler] mode before connect():', SoftprobeContext.getMode());

  try {
    await client.connect();
    console.log('[handler] connect() = no-op ✓');
    await client.set('k', 'v');
    const v = await client.get('k');
    console.log('[handler] get result:', v);
    await client.quit();
  } catch (e: unknown) {
    const err = e as { constructor: { name: string }; message?: string };
    console.log('[handler] connect() threw:', err.constructor.name);
  }
  res.json({ mode: SoftprobeContext.getMode() });
});

const server = app.listen(3095, async () => {
  console.log('server listening on 3095');
  try {
    const resp = await fetch('http://127.0.0.1:3095/test', {
      headers: {
        'x-softprobe-mode': 'REPLAY',
        'x-softprobe-trace-id': 'softprobe-test',
      },
    });
    const body = await resp.text();
    console.log('[client] response status:', resp.status);
    console.log('[client] response body:', body.slice(0, 200));
  } catch (e) {
    console.error('[client] fetch error:', e);
  } finally {
    server.close();
    try { await sdk.shutdown(); } catch {}
  }
});
