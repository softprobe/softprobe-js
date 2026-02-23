/**
 * Task 14.4.2: Express replay E2E succeeds with dependencies offline.
 * Test: run Express app in REPLAY + strict mode with Postgres/Redis/http
 * dependency disabled; request succeeds from cassette only.
 */

import fs from 'fs';
import path from 'path';
import { runServer, waitForServer } from './run-child';
import { loadNdjson } from '../../store/load-ndjson';
import type { SoftprobeCassetteRecord } from '../../types/schema';

const WORKER_SCRIPT = path.join(__dirname, 'helpers', 'express-inbound-worker.ts');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

function getInboundRecords(records: SoftprobeCassetteRecord[]): SoftprobeCassetteRecord[] {
  return records.filter((r) => r.type === 'inbound');
}

describe('E2E Express inbound replay (Task 14.4.2)', () => {
  let cassettePath: string;
  let capturedTraceId: string;

  beforeAll(async () => {
    cassettePath = path.join(PROJECT_ROOT, `express-replay-e2e-${Date.now()}.ndjson`);
    if (fs.existsSync(cassettePath)) fs.unlinkSync(cassettePath);

    const port = 30000 + (Date.now() % 10000);
    const child = runServer(
      WORKER_SCRIPT,
      {
        PORT: String(port),
        SOFTPROBE_MODE: 'CAPTURE',
        SOFTPROBE_CASSETTE_PATH: cassettePath,
      },
      { useTsNode: true }
    );
    try {
      await waitForServer(port, 20000);
      await fetch(`http://127.0.0.1:${port}/`);
      await fetch(`http://127.0.0.1:${port}/exit`).catch(() => {});
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
        setTimeout(resolve, 3000);
      });
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }

    expect(fs.existsSync(cassettePath)).toBe(true);
    const records = await loadNdjson(cassettePath);
    const inbound = getInboundRecords(records);
    expect(inbound.length).toBeGreaterThanOrEqual(1);
    capturedTraceId = inbound[0].traceId;
    expect(capturedTraceId).toBeDefined();
  }, 35000);

  afterAll(() => {
    if (fs.existsSync(cassettePath)) fs.unlinkSync(cassettePath);
  });

  it('REPLAY + strict succeeds from cassette with dependencies offline', async () => {
    const port = 30010 + (Date.now() % 10000);
    const child = runServer(
      WORKER_SCRIPT,
      {
        PORT: String(port),
        SOFTPROBE_MODE: 'REPLAY',
        SOFTPROBE_STRICT_REPLAY: '1',
        SOFTPROBE_CASSETTE_PATH: cassettePath,
      },
      { useTsNode: true }
    );

    try {
      await waitForServer(port, 20000);
      const traceparent = `00-${capturedTraceId}-0000000000000001-01`;
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { traceparent },
      });
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { ok?: boolean; outbound?: unknown };
      expect(body.ok).toBe(true);
      expect(body.outbound).toBeDefined();

      const records = await loadNdjson(cassettePath);
      const outboundHttp = records.find(
        (r) => r.traceId === capturedTraceId && r.type === 'outbound' && r.protocol === 'http'
      );
      expect(outboundHttp).toBeDefined();
      const recordedBody = (outboundHttp as SoftprobeCassetteRecord).responsePayload as { body?: unknown } | undefined;
      expect(body.outbound).toEqual(recordedBody?.body ?? recordedBody);

      await fetch(`http://127.0.0.1:${port}/exit`).catch(() => {});
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
        setTimeout(resolve, 3000);
      });
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 30000);
});
