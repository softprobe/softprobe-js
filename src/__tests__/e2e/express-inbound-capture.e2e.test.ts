/**
 * Task 14.4.1: Express capture E2E writes inbound + outbound records.
 * Test: run Express app in CAPTURE; hit one route; NDJSON contains inbound record
 * (status/body) and at least one outbound record (http/redis/postgres).
 *
 * Inbound = request INTO the app (the HTTP request we send to GET / and the response
 * the app returns). Recorded by Express middleware with type 'inbound'.
 *
 * Outbound = calls the app makes TO external backends (e.g. fetch() to httpbin,
 * Postgres, Redis). Recorded by instrumentation with type 'outbound'.
 */

import fs from 'fs';
import path from 'path';
import { runServer, waitForServer, closeServer } from './run-child';
import { loadNdjson } from '../../store/load-ndjson';
import type { SoftprobeCassetteRecord } from '../../types/schema';
import { E2eArtifacts } from './helpers/e2e-artifacts';

const WORKER_SCRIPT = path.join(__dirname, 'helpers', 'express-inbound-worker.ts');

/** Records for requests INTO the app (e.g. GET / and its response). */
function getInboundRecords(records: SoftprobeCassetteRecord[]): SoftprobeCassetteRecord[] {
  return records.filter((r) => r.type === 'inbound');
}

/** Records for calls the app makes TO external backends (http/redis/postgres). */
function getOutboundRecords(records: SoftprobeCassetteRecord[]): SoftprobeCassetteRecord[] {
  return records.filter(
    (r) =>
      r.type === 'outbound' &&
      (r.protocol === 'http' || r.protocol === 'redis' || r.protocol === 'postgres')
  );
}

describe('E2E Express inbound capture (Task 14.4.1)', () => {
  let artifacts: E2eArtifacts;
  let cassettePath: string;

  beforeAll(() => {
    artifacts = new E2eArtifacts();
    cassettePath = artifacts.createTempFile('express-inbound-e2e', '.ndjson');
  });

  afterAll(() => {
    artifacts.cleanup();
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

    // Inbound: the GET / request we sent and the 200 response the app returned.
    const inbound = getInboundRecords(records);
    expect(inbound.length).toBeGreaterThanOrEqual(1);
    const oneInbound = inbound[0];
    expect(oneInbound.type).toBe('inbound');
    expect(oneInbound.protocol).toBe('http');
    expect(oneInbound.responsePayload).toBeDefined();
    expect((oneInbound.responsePayload as { statusCode?: number }).statusCode).toBe(200);
    expect((oneInbound.responsePayload as { body?: unknown }).body).toBeDefined();

    // Outbound: at least one dependency call the app made (e.g. fetch to httpbin).
    const outbound = getOutboundRecords(records);
    expect(outbound.length).toBeGreaterThanOrEqual(1);
  }, 30000);
});
