/**
 * Task 9.3: Strict negative E2E for unrecorded call.
 * Unrecorded outbound call in strict replay must fail deterministically and not hit network.
 */

import fs from 'fs';
import path from 'path';
import { runServer, waitForServer, closeServer } from './run-child';

const EXPRESS_WORKER = path.join(__dirname, 'helpers', 'express-inbound-worker.ts');
const PROBE_WORKER = path.join(__dirname, 'helpers', 'network-probe-server.ts');
const FIXTURE_CASSETTE = path.join(__dirname, 'fixtures', 'express-replay.ndjson');
const FIXTURE_TRACE_ID = '00000000000000000000000000000001';

describe('Task 9.3 - strict negative replay for unrecorded outbound call', () => {
  it('fails deterministically and does not hit network for unrecorded outbound', async () => {
    const fixtureDir = path.join(path.dirname(FIXTURE_CASSETTE), `task-9-3-${Date.now()}`);
    fs.mkdirSync(fixtureDir, { recursive: true });
    const fixtureCopy = path.join(fixtureDir, `${FIXTURE_TRACE_ID}.ndjson`);
    fs.copyFileSync(FIXTURE_CASSETTE, fixtureCopy);

    const probePort = 31500 + (Date.now() % 10000);
    const probeChild = runServer(PROBE_WORKER, { PORT: String(probePort) }, { useTsNode: true });
    const appPort = 31600 + (Date.now() % 10000);
    const appChild = runServer(
      EXPRESS_WORKER,
      {
        PORT: String(appPort),
        SOFTPROBE_MODE: 'REPLAY',
        SOFTPROBE_STRICT_REPLAY: '1',
        SOFTPROBE_CASSETTE_PATH: fixtureCopy,
        SOFTPROBE_E2E_UNRECORDED_URL: `http://127.0.0.1:${probePort}/probe-call`,
      },
      { useTsNode: true }
    );

    try {
      await waitForServer(probePort, 20000);
      await waitForServer(appPort, 20000);

      const traceparent = `00-${FIXTURE_TRACE_ID}-0000000000000001-01`;
      const res = await fetch(`http://127.0.0.1:${appPort}/unrecorded`, {
        headers: {
          traceparent,
          'x-softprobe-trace-id': FIXTURE_TRACE_ID,
        },
        signal: AbortSignal.timeout(15000),
      });

      expect(res.status).toBe(500);
      const contentType = res.headers.get('content-type') ?? '';
      const body = contentType.includes('json')
        ? ((await res.json()) as { error?: string })
        : { error: await res.text() };
      expect(body.error).toBeDefined();
      expect(String(body.error)).toMatch(/no recorded traces|Softprobe|No recorded/i);

      const hitsRes = await fetch(`http://127.0.0.1:${probePort}/hits`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(hitsRes.ok).toBe(true);
      const hits = (await hitsRes.json()) as { hitCount?: number };
      expect(hits.hitCount).toBe(0);

      await fetch(`http://127.0.0.1:${appPort}/exit`, { signal: AbortSignal.timeout(5000) }).catch(() => {});
      await new Promise<void>((resolve) => {
        appChild.once('exit', () => resolve());
        setTimeout(resolve, 5000);
      });
    } finally {
      await closeServer(appChild);
      await closeServer(probeChild);
    }
  }, 30000);
});
