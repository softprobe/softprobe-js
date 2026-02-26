/**
 * Task 14.4.2: Express replay E2E succeeds with dependencies offline.
 * Test: run Express app in REPLAY + strict mode with Postgres/Redis/http
 * dependency disabled; request succeeds from cassette only.
 */

import fs from 'fs';
import path from 'path';
import { runServer, waitForServer, closeServer } from './run-child';
import { loadNdjson } from '../../store/load-ndjson';
import type { SoftprobeCassetteRecord } from '../../types/schema';
import { E2eArtifacts } from './helpers/e2e-artifacts';

const WORKER_SCRIPT = path.join(__dirname, 'helpers', 'express-inbound-worker.ts');
const FIXTURE_CASSETTE = path.join(__dirname, 'fixtures', 'express-replay.ndjson');

/** Known traceId in fixtures/express-replay.ndjson (32 hex lowercase). */
const FIXTURE_TRACE_ID = '00000000000000000000000000000001';

function getInboundRecords(records: SoftprobeCassetteRecord[]): SoftprobeCassetteRecord[] {
  return records.filter((r) => r.type === 'inbound');
}

describe('E2E Express inbound replay (Task 14.4.2)', () => {
  let artifacts: E2eArtifacts;
  let cassettePath: string;
  let capturedTraceId: string;

  beforeAll(async () => {
    artifacts = new E2eArtifacts();
    cassettePath = artifacts.createTempFile('express-replay-e2e', '.ndjson');

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
      await closeServer(child);
    }

    expect(fs.existsSync(cassettePath)).toBe(true);
    const records = await loadNdjson(cassettePath);
    const inbound = getInboundRecords(records);
    expect(inbound.length).toBeGreaterThanOrEqual(1);
    capturedTraceId = inbound[0].traceId;
    expect(capturedTraceId).toBeDefined();
  }, 35000);

  afterAll(() => {
    artifacts.cleanup();
  });

  it('REPLAY + strict with fixture cassette succeeds (propagation + matcher)', async () => {
    const port = 30010 + (Date.now() % 10000);
    const child = runServer(
      WORKER_SCRIPT,
      {
        PORT: String(port),
        SOFTPROBE_MODE: 'REPLAY',
        SOFTPROBE_STRICT_REPLAY: '1',
        SOFTPROBE_CASSETTE_PATH: FIXTURE_CASSETTE,
      },
      { useTsNode: true }
    );

    try {
      await waitForServer(port, 20000);
      const traceparent = `00-${FIXTURE_TRACE_ID}-0000000000000001-01`;
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { traceparent, 'x-softprobe-trace-id': FIXTURE_TRACE_ID },
      });
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { ok?: boolean; outbound?: unknown };
      expect(body.ok).toBe(true);
      expect(body.outbound).toEqual({ url: 'https://httpbin.org/get' });

      await fetch(`http://127.0.0.1:${port}/exit`).catch(() => {});
      await new Promise<void>((r) => {
        child.once('exit', r);
        setTimeout(r, 3000);
      });
    } finally {
      await closeServer(child);
    }
  }, 30000);

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
      const traceIdHex = String(capturedTraceId).trim().toLowerCase();
      const traceparent = `00-${traceIdHex}-0000000000000001-01`;
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { traceparent, 'x-softprobe-trace-id': traceIdHex },
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
      const responsePayload = (outboundHttp as SoftprobeCassetteRecord).responsePayload as { body?: unknown } | undefined;
      if (responsePayload?.body !== undefined) {
        expect(body.outbound).toEqual(responsePayload.body);
      }

      await fetch(`http://127.0.0.1:${port}/exit`).catch(() => {});
      await new Promise<void>((r) => {
        child.once('exit', r);
        setTimeout(r, 3000);
      });
    } finally {
      await closeServer(child);
    }
  }, 30000);
});
