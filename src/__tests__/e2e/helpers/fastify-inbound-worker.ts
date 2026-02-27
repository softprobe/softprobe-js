/**
 * Shared Fastify app for inbound capture and replay E2E (Task 14.4.3).
 * Mode is driven by YAML config (SOFTPROBE_CONFIG_PATH).
 * - CAPTURE: cassettePath in config; GET /exit flushes store and exits.
 * - REPLAY: uses runtime replay wiring from init + middleware/context run path; GET /exit exits.
 * PORT required for both.
 * Same route flow as Express worker: GET / does outbound fetch to httpbin.org.
 */

import '../../../init';
import { ConfigManager } from '../../../config/config-manager';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({
  instrumentations: [getNodeAutoInstrumentations()],
});
sdk.start();
(globalThis as unknown as { __softprobeApplyHttpReplay?: () => void }).__softprobeApplyHttpReplay?.();

const configPath = process.env.SOFTPROBE_CONFIG_PATH ?? './.softprobe/config.yml';
let softprobeMode = 'PASSTHROUGH';
try {
  const cfg = new ConfigManager(configPath).get();
  softprobeMode = cfg.mode ?? 'PASSTHROUGH';
} catch {
  softprobeMode = 'PASSTHROUGH';
}
const isReplay = softprobeMode === 'REPLAY';

// #region agent log
function _dbg(location: string, message: string, data: Record<string, unknown>): void {
  fetch('http://127.0.0.1:7242/ingest/abae8b62-1eb2-436b-99c9-e8e6a9718ab9', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location, message, data, timestamp: Date.now() }) }).catch(() => {});
}
// #endregion

async function startServer(): Promise<void> {
  _dbg('fastify-inbound-worker.ts:startServer', 'startServer entered', { port: process.env.PORT, isReplay });
  const fastify = require('fastify');
  const app = await fastify();

  app.get('/', async (_req: unknown, reply: { status: (n: number) => { send: (body: unknown) => Promise<unknown> }; send: (body: unknown) => Promise<unknown> }) => {
    const r = await fetch('https://httpbin.org/get', { signal: AbortSignal.timeout(15000) });
    const j = (await r.json()) as Record<string, unknown>;
    return reply.status(200).send({ ok: true, outbound: j });
  });

  /** Route that performs an outbound call not in the default fixture (for strict-negative E2E). Propagates outbound error status so client sees failure when strict replay returns 500. */
  app.get('/unrecorded', async (_req: unknown, reply: { status: (n: number) => { send: (body: unknown) => Promise<unknown> }; send: (body: unknown) => Promise<unknown> }) => {
    const r = await fetch('https://httpbin.org/post', { method: 'POST', body: '{}', signal: AbortSignal.timeout(15000) });
    const j = (await r.json()) as Record<string, unknown>;
    if (!r.ok) return reply.status(r.status).send(j);
    return reply.status(200).send({ ok: true, outbound: j });
  });

  app.get('/exit', (_req: unknown, reply: { send: (s: string) => unknown }) => {
    reply.send('ok');
    setImmediate(() => {
      // Background flusher handles flush; direct write needs no explicit flush
      process.exit(0);
    });
  });

  const port = parseInt(process.env.PORT || '0', 10) || 39302;
  _dbg('fastify-inbound-worker.ts:startServer', 'listen called', { port });
  await app.listen({ port, host: '0.0.0.0' });
  _dbg('fastify-inbound-worker.ts:startServer', 'listen callback', { port });
  process.stdout.write(JSON.stringify({ port }) + '\n');
}

startServer().catch((err: unknown) => {
  process.stderr.write((err instanceof Error ? err.stack : String(err)) ?? '');
  process.exit(1);
});
