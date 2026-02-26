/**
 * Task 12.4 HTTP E2E:
 * - 12.4.1 CAPTURE writes NDJSON
 * - 12.4.2 REPLAY runs with network disabled (no live server)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { runChild, runServer, waitForServer, closeServer } from './run-child';
import { loadNdjson } from '../../store/load-ndjson';
import type { SoftprobeCassetteRecord } from '../../types/schema';

const CAPTURE_WORKER = path.join(__dirname, 'helpers', 'http-cassette-capture-worker.ts');
const REPLAY_WORKER = path.join(__dirname, 'helpers', 'http-replay-worker.ts');
const PROBE_WORKER = path.join(__dirname, 'helpers', 'network-probe-server.ts');

function getHttpOutboundRecords(records: SoftprobeCassetteRecord[]): SoftprobeCassetteRecord[] {
  return records.filter((r) => r.type === 'outbound' && r.protocol === 'http');
}

describe('E2E HTTP cassette capture/replay (Task 12.4)', () => {
  let cassettePath: string;
  let recordedUrl: string;

  beforeAll(() => {
    cassettePath = path.join(
      os.tmpdir(),
      `softprobe-e2e-cassette-http-${Date.now()}.ndjson`
    );
    if (fs.existsSync(cassettePath)) fs.unlinkSync(cassettePath);
  });

  afterAll(() => {
    if (fs.existsSync(cassettePath)) fs.unlinkSync(cassettePath);
  });

  it('12.4.1: CAPTURE writes NDJSON', async () => {
    const probePort = 31700 + (Date.now() % 10000);
    const probeChild = runServer(
      PROBE_WORKER,
      { PORT: String(probePort) },
      { useTsNode: true }
    );
    try {
      await waitForServer(probePort, 20000);
      const captureUrl = `http://127.0.0.1:${probePort}/payload`;
      const result = runChild(
        CAPTURE_WORKER,
        {
          SOFTPROBE_MODE: 'CAPTURE',
          SOFTPROBE_CASSETTE_PATH: cassettePath,
          CAPTURE_URL: captureUrl,
        },
        { useTsNode: true }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');

      const captureOut = JSON.parse(result.stdout) as { url: string; status: number; body: string };
      recordedUrl = captureOut.url;

      expect(fs.existsSync(cassettePath)).toBe(true);
      const records = await loadNdjson(cassettePath);
      const httpRecords = getHttpOutboundRecords(records);
      expect(httpRecords.length).toBeGreaterThanOrEqual(1);

      const targetIdentifier = `GET ${captureOut.url}`;
      const targetRecord = httpRecords.find((r) => r.identifier === targetIdentifier);

      expect(targetRecord).toBeDefined();
      const payload = (targetRecord?.responsePayload ?? {}) as { statusCode?: number; body?: string };
      expect(payload.statusCode).toBe(captureOut.status);
      expect(payload.body).toBe(captureOut.body);
    } finally {
      await closeServer(probeChild);
    }
  }, 60000);

  it('12.4.2: REPLAY runs with network disabled (no live server)', () => {
    // The capture worker closes its local HTTP server before exiting. If replay did passthrough,
    // this fetch would fail with connection refused.
    const result = runChild(
      REPLAY_WORKER,
      {
        SOFTPROBE_MODE: 'REPLAY',
        SOFTPROBE_CASSETTE_PATH: cassettePath,
        REPLAY_URL: recordedUrl,
      },
      { useTsNode: true }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const replayOut = JSON.parse(result.stdout) as { status: number; body: string };
    expect(replayOut.status).toBe(200);
  }, 60000);
});
