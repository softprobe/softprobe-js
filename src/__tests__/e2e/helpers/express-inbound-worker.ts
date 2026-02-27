/**
 * Shared Express app for inbound capture and replay E2E (Tasks 14.4.1, 14.4.2).
 *
 * Inbound vs outbound (for capture/replay):
 * - Inbound = HTTP request INTO this app (e.g. GET /). Express middleware records it (type 'inbound').
 * - Outbound = Calls this app makes TO external backends (e.g. fetch()). Instrumentation records them (type 'outbound').
 *
 * Mode is driven by YAML config (SOFTPROBE_CONFIG_PATH).
 * - CAPTURE: cassettePath in config; GET /exit flushes store and exits.
 * - REPLAY: uses runtime replay wiring from init + middleware/context run path; GET /exit exits.
 * - SOFTPROBE_E2E_OUTBOUND_URL optionally overrides default outbound URL for deterministic local tests.
 * - SOFTPROBE_E2E_UNRECORDED_URL optionally overrides strict-negative outbound URL.
 * PORT required for both.
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
  const express = require('express');
  const app = express();

  // INBOUND: This route is the "inbound" — the request comes INTO our app (GET /).
  // Express/Softprobe middleware records it as type 'inbound' (request + response).
  app.get('/', async (_req: unknown, res: { status: (n: number) => { json: (body: unknown) => void }; json: (body: unknown) => void }) => {
    // OUTBOUND: This fetch() is a call FROM our app TO an external backend.
    // Instrumentation records it as type 'outbound' (e.g. protocol 'http').
    const r = await fetch(outboundUrl, { signal: AbortSignal.timeout(15000) });
    const j = (await r.json()) as Record<string, unknown>;
    res.status(200).json({ ok: true, outbound: j });
  });

  /** INBOUND: GET /unrecorded is the inbound request. OUTBOUND: fetch(unrecordedUrl) below. In strict replay the unrecorded outbound fails. */
  app.get('/unrecorded', async (_req: unknown, res: { status: (n: number) => { json: (body: unknown) => void } }) => {
    const r = await fetch(unrecordedUrl, { signal: AbortSignal.timeout(15000) });
    const j = (await r.json()) as Record<string, unknown>;
    if (!r.ok) return res.status(r.status).json(j);
    return res.status(200).json({ ok: true, outbound: j });
  });

  app.get('/exit', (_req: unknown, res: { send: (s: string) => void }) => {
    res.send('ok');
    setImmediate(() => {
      // Background flusher handles flush; direct write needs no explicit flush
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
