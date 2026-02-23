/**
 * Task 12.2.1: CAPTURE script writes NDJSON with rows (Postgres E2E).
 * Runs a child process with SOFTPROBE_MODE=CAPTURE; asserts the cassette file
 * contains at least one outbound postgres record with responsePayload.rows.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runChild } from './run-child';
import { loadNdjson } from '../../store/load-ndjson';
import type { SoftprobeCassetteRecord } from '../../types/schema';
import { setupPostgresReplay } from '../../replay/postgres';

const WORKER_SCRIPT = path.join(__dirname, 'helpers', 'pg-cassette-capture-worker.ts');

function getPostgresOutboundRecords(
  records: SoftprobeCassetteRecord[]
): SoftprobeCassetteRecord[] {
  return records.filter(
    (r) => r.type === 'outbound' && r.protocol === 'postgres'
  );
}

describe('E2E Postgres cassette capture (Task 12.2.1)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let cassettePath: string;

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:16').start();
    cassettePath = path.join(
      os.tmpdir(),
      `softprobe-e2e-cassette-pg-${Date.now()}.ndjson`
    );
    if (fs.existsSync(cassettePath)) fs.unlinkSync(cassettePath);
  }, 60000);

  afterAll(async () => {
    await pgContainer?.stop();
    if (fs.existsSync(cassettePath)) fs.unlinkSync(cassettePath);
  });

  it('12.2.1: CAPTURE script writes NDJSON with rows', async () => {
    const result = runChild(
      WORKER_SCRIPT,
      {
        SOFTPROBE_MODE: 'CAPTURE',
        SOFTPROBE_CASSETTE_PATH: cassettePath,
        PG_URL: pgContainer.getConnectionUri(),
      },
      { useTsNode: true }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    expect(fs.existsSync(cassettePath)).toBe(true);
    const records = await loadNdjson(cassettePath);
    const pgRecords = getPostgresOutboundRecords(records);
    expect(pgRecords.length).toBeGreaterThanOrEqual(1);

    for (const rec of pgRecords) {
      expect(rec.version).toBe('4.1');
      expect(rec.identifier).toBeDefined();
      expect(rec.responsePayload).toBeDefined();
      const payload = rec.responsePayload as { rows?: unknown[] };
      expect(Array.isArray(payload.rows)).toBe(true);
      expect(payload.rows!.length).toBeGreaterThanOrEqual(0);
    }
  });
});

/**
 * Task 12.2.2: REPLAY works with DB disconnected.
 * Capture uses a real Postgres container to record; replay uses the cassette only (dummy PG URL).
 */
describe('E2E Postgres cassette replay (Task 12.2.2)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let cassettePath: string;

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:16').start();
    cassettePath = path.join(
      os.tmpdir(),
      `softprobe-e2e-replay-pg-${Date.now()}.ndjson`
    );
    if (fs.existsSync(cassettePath)) fs.unlinkSync(cassettePath);
  }, 60000);

  afterAll(async () => {
    await pgContainer?.stop();
    if (fs.existsSync(cassettePath)) fs.unlinkSync(cassettePath);
  });

  it('12.2.2: REPLAY script works with DB disconnected', async () => {
    setupPostgresReplay();
    // CAPTURE step: run worker with a real Postgres URL so it can record the query into the cassette.
    const captureResult = runChild(
      WORKER_SCRIPT,
      {
        SOFTPROBE_MODE: 'CAPTURE',
        SOFTPROBE_CASSETTE_PATH: cassettePath,
        PG_URL: pgContainer.getConnectionUri(), // valid URL — real Postgres container
      },
      { useTsNode: true }
    );
    expect(captureResult.exitCode).toBe(0);

    // REPLAY step: run in-process with a dummy URL — no real DB. The replay wrapper returns
    // the recorded payload, so the query never hits the network.
    const { softprobe } = await import('../../api');
    const replayed = await softprobe.runWithContext(
      { cassettePath },
      async () => {
        const { Client } = require('pg');
        const client = new Client({ connectionString: 'postgres://localhost:9999/nodb' }); // intentionally invalid
        const queryText = 'SELECT 1 AS num, $1::text AS label';
        const values = ['e2e-cassette'];
        const result = await client.query(queryText, values);
        return { rows: result.rows, rowCount: result.rowCount };
      }
    );

    expect(replayed).toBeDefined();
    expect(Array.isArray(replayed!.rows)).toBe(true);
    expect(replayed!.rowCount).toBeGreaterThanOrEqual(0);
    expect(replayed!.rows!.length).toBeGreaterThanOrEqual(1);
  });
});
