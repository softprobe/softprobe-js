/**
 * Shared Express app for inbound capture and replay E2E (Tasks 14.4.1, 14.4.2).
 * Mode is driven by env: SOFTPROBE_MODE=CAPTURE | REPLAY.
 * - CAPTURE: SOFTPROBE_CASSETTE_PATH required; GET /exit flushes store and exits.
 * - REPLAY: SOFTPROBE_CASSETTE_PATH required; loads cassette and sets global matcher before listen; GET /exit exits.
 * - SOFTPROBE_E2E_OUTBOUND_URL optionally overrides default outbound URL for deterministic local tests.
 * - SOFTPROBE_E2E_UNRECORDED_URL optionally overrides strict-negative outbound URL.
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
const outboundUrl = process.env.SOFTPROBE_E2E_OUTBOUND_URL || 'https://httpbin.org/get';
const unrecordedUrl = process.env.SOFTPROBE_E2E_UNRECORDED_URL || 'https://httpbin.org/post';

// #region agent log
function _dbg(location: string, message: string, data: Record<string, unknown>): void {
  fetch('http://127.0.0.1:7242/ingest/abae8b62-1eb2-436b-99c9-e8e6a9718ab9', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location, message, data, timestamp: Date.now() }) }).catch(() => {});
}
// #endregion

async function startServer(): Promise<void> {
  // #region agent log
  _dbg('express-inbound-worker.ts:startServer', 'startServer entered', { port: process.env.PORT, isReplay });
  // #endregion
  if (isReplay) {
    const cassettePath = process.env.SOFTPROBE_CASSETTE_PATH;
    if (!cassettePath) throw new Error('SOFTPROBE_CASSETTE_PATH is required for REPLAY');
    const records = await loadNdjson(cassettePath);
    // #region agent log
    _dbg('express-inbound-worker.ts:startServer', 'loadNdjson done', { recordCount: records.length });
    // #endregion
    softprobe.setReplayRecordsCache(records);
    const matcher = new SoftprobeMatcher();
    matcher.use(createDefaultMatcher());
    softprobe.setGlobalReplayMatcher(matcher);
  }

  const express = require('express');
  const app = express();

  app.get('/', async (_req: unknown, res: { status: (n: number) => { json: (body: unknown) => void }; json: (body: unknown) => void }) => {
    const r = await fetch(outboundUrl, { signal: AbortSignal.timeout(15000) });
    const j = (await r.json()) as Record<string, unknown>;
    res.status(200).json({ ok: true, outbound: j });
  });

  /** Route that performs an unrecorded outbound call; in strict replay this should return softprobe 500 and never passthrough. */
  app.get('/unrecorded', async (_req: unknown, res: { status: (n: number) => { json: (body: unknown) => void } }) => {
    const r = await fetch(unrecordedUrl, { signal: AbortSignal.timeout(15000) });
    const j = (await r.json()) as Record<string, unknown>;
    if (!r.ok) return res.status(r.status).json(j);
    return res.status(200).json({ ok: true, outbound: j });
  });

  app.get('/exit', (_req: unknown, res: { send: (s: string) => void }) => {
    res.send('ok');
    setImmediate(() => {
      if (!isReplay) getCaptureStore()?.flushOnExit();
      process.exit(0);
    });
  });

  const port = parseInt(process.env.PORT || '0', 10) || 39301;
  // #region agent log
  _dbg('express-inbound-worker.ts:startServer', 'listen called', { port });
  // #endregion
  app.listen(port, () => {
    // #region agent log
    _dbg('express-inbound-worker.ts:startServer', 'listen callback', { port });
    // #endregion
    process.stdout.write(JSON.stringify({ port }) + '\n');
  });
}

startServer().catch((err: unknown) => {
  process.stderr.write((err instanceof Error ? err.stack : String(err)) ?? '');
  process.exit(1);
});
