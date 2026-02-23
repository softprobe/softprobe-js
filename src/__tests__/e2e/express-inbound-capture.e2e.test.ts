/**
 * Task 14.4.1: Express capture E2E writes inbound + outbound records.
 * Test: run Express app in CAPTURE; hit one route; NDJSON contains inbound record
 * (status/body) and at least one outbound record (http/redis/postgres).
 */

import fs from 'fs';
import path from 'path';
import { runServer, waitForServer, closeServer } from './run-child';
import { loadNdjson } from '../../store/load-ndjson';
import type { SoftprobeCassetteRecord } from '../../types/schema';

const WORKER_SCRIPT = path.join(__dirname, 'helpers', 'express-inbound-worker.ts');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

function getInboundRecords(records: SoftprobeCassetteRecord[]): SoftprobeCassetteRecord[] {
  return records.filter((r) => r.type === 'inbound');
}

function getOutboundRecords(records: SoftprobeCassetteRecord[]): SoftprobeCassetteRecord[] {
  return records.filter(
    (r) =>
      r.type === 'outbound' &&
      (r.protocol === 'http' || r.protocol === 'redis' || r.protocol === 'postgres')
  );
}

describe('E2E Express inbound capture (Task 14.4.1)', () => {
  let cassettePath: string;

  beforeAll(() => {
    cassettePath = path.join(PROJECT_ROOT, `express-inbound-e2e-${Date.now()}.ndjson`);
    if (fs.existsSync(cassettePath)) fs.unlinkSync(cassettePath);
  });

  afterAll(() => {
    if (fs.existsSync(cassettePath)) fs.unlinkSync(cassettePath);
  });

  it('CAPTURE writes NDJSON with inbound record and at least one outbound record', async () => {
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
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.ok).toBe(true);
      await fetch(`http://127.0.0.1:${port}/exit`).catch(() => {});
      await new Promise<void>((r) => {
        child.once('exit', r);
        setTimeout(r, 3000);
      });
    } finally {
      await closeServer(child);
    }

    expect(fs.existsSync(cassettePath)).toBe(true);
    const records = await loadNdjson(cassettePath);

    const inbound = getInboundRecords(records);
    expect(inbound.length).toBeGreaterThanOrEqual(1);
    const oneInbound = inbound[0];
    expect(oneInbound.type).toBe('inbound');
    expect(oneInbound.protocol).toBe('http');
    expect(oneInbound.responsePayload).toBeDefined();
    expect((oneInbound.responsePayload as { statusCode?: number }).statusCode).toBe(200);
    expect((oneInbound.responsePayload as { body?: unknown }).body).toBeDefined();

    const outbound = getOutboundRecords(records);
    expect(outbound.length).toBeGreaterThanOrEqual(1);
  }, 30000);
});
