/**
 * Shared Fastify app for inbound capture and replay E2E (Task 14.4.3).
 * Mode is driven by env: SOFTPROBE_MODE=CAPTURE | REPLAY.
 * - CAPTURE: SOFTPROBE_CASSETTE_PATH required; GET /exit flushes store and exits.
 * - REPLAY: SOFTPROBE_CASSETTE_PATH required; loads cassette and sets global matcher before listen; GET /exit exits.
 * PORT required for both.
 * Same route flow as Express worker: GET / does outbound fetch to httpbin.org.
 */

import '../../../init';
import { getCaptureStore } from '../../../capture/store-accessor';
import { loadNdjson } from '../../../store/load-ndjson';
import { softprobe } from '../../../api';
import { SoftprobeMatcher } from '../../../replay/softprobe-matcher';
import { createDefaultMatcher } from '../../../replay/extract-key';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({
  instrumentations: [getNodeAutoInstrumentations()],
});
sdk.start();

const isReplay = process.env.SOFTPROBE_MODE === 'REPLAY';

async function startServer(): Promise<void> {
  if (isReplay) {
    const cassettePath = process.env.SOFTPROBE_CASSETTE_PATH;
    if (!cassettePath) throw new Error('SOFTPROBE_CASSETTE_PATH is required for REPLAY');
    const records = await loadNdjson(cassettePath);
    softprobe.setReplayRecordsCache(records);
    const matcher = new SoftprobeMatcher();
    matcher.use(createDefaultMatcher());
    softprobe.setGlobalReplayMatcher(matcher);
  }

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
      if (!isReplay) getCaptureStore()?.flushOnExit();
      process.exit(0);
    });
  });

  const port = parseInt(process.env.PORT || '0', 10) || 39302;
  await app.listen({ port, host: '0.0.0.0' });
  process.stdout.write(JSON.stringify({ port }) + '\n');
}

startServer().catch((err: unknown) => {
  process.stderr.write((err instanceof Error ? err.stack : String(err)) ?? '');
  process.exit(1);
});
