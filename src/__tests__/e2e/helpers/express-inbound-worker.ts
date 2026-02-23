/**
 * Shared Express app for inbound capture and replay E2E (Tasks 14.4.1, 14.4.2).
 * Mode is driven by env: SOFTPROBE_MODE=CAPTURE | REPLAY.
 * - CAPTURE: SOFTPROBE_CASSETTE_PATH required; GET /exit flushes store and exits.
 * - REPLAY: SOFTPROBE_CASSETTE_PATH required; loads cassette and sets global matcher before listen; GET /exit exits.
 * PORT required for both.
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

  const express = require('express');
  const app = express();

  app.get('/', async (_req: unknown, res: { status: (n: number) => { json: (body: unknown) => void }; json: (body: unknown) => void }) => {
    const r = await fetch('https://httpbin.org/get');
    const j = (await r.json()) as Record<string, unknown>;
    res.status(200).json({ ok: true, outbound: j });
  });

  app.get('/exit', (_req: unknown, res: { send: (s: string) => void }) => {
    res.send('ok');
    setImmediate(() => {
      if (!isReplay) getCaptureStore()?.flushOnExit();
      process.exit(0);
    });
  });

  const port = parseInt(process.env.PORT || '0', 10) || 39301;
  app.listen(port, () => {
    process.stdout.write(JSON.stringify({ port }) + '\n');
  });
}

startServer().catch((err: unknown) => {
  process.stderr.write((err instanceof Error ? err.stack : String(err)) ?? '');
  process.exit(1);
});
