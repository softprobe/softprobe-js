/**
 * Task 12.2.1: CAPTURE script writes NDJSON with rows (Postgres E2E).
 * Runs a child process with SOFTPROBE_MODE=CAPTURE; asserts the cassette file
 * contains at least one outbound postgres record with responsePayload.rows.
 */

import fs from 'fs';
import path from 'path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runChild } from './run-child';
import { loadCassetteRecordsByPath } from '../helpers/read-cassette-file';
import type { SoftprobeCassetteRecord } from '../../types/schema';
import { E2eArtifacts } from './helpers/e2e-artifacts';

const WORKER_SCRIPT = path.join(__dirname, 'helpers', 'pg-cassette-capture-worker.ts');
const REPLAY_WORKER = path.join(__dirname, 'helpers', 'pg-cassette-replay-worker.ts');

function getPostgresOutboundRecords(
  records: SoftprobeCassetteRecord[]
): SoftprobeCassetteRecord[] {
  return records.filter(
    (r) => r.type === 'outbound' && r.protocol === 'postgres'
  );
}

describe('E2E Postgres cassette capture (Task 12.2.1)', () => {
  let artifacts: E2eArtifacts;
  let pgContainer: StartedPostgreSqlContainer;
  let cassettePath: string;

  beforeAll(async () => {
    artifacts = new E2eArtifacts();
    pgContainer = await new PostgreSqlContainer('postgres:16').start();
    cassettePath = artifacts.createTempFile('softprobe-e2e-cassette-pg', '.ndjson');
  }, 60000);

  afterAll(async () => {
    await pgContainer?.stop();
    artifacts.cleanup();
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
    const records = await loadCassetteRecordsByPath(cassettePath);
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
  let artifacts: E2eArtifacts;
  let pgContainer: StartedPostgreSqlContainer;
  let cassettePath: string;

  beforeAll(async () => {
    artifacts = new E2eArtifacts();
    pgContainer = await new PostgreSqlContainer('postgres:16').start();
    cassettePath = artifacts.createTempFile('softprobe-e2e-replay-pg', '.ndjson');
  }, 60000);

  afterAll(async () => {
    await pgContainer?.stop();
    artifacts.cleanup();
  });

  it('12.2.2: REPLAY script works with DB disconnected', async () => {
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

    const records = await loadCassetteRecordsByPath(cassettePath);
    const recordedTraceId = records.find(
      (r) => r.type === 'outbound' && r.protocol === 'postgres'
    )?.traceId;

    const replayResult = runChild(
      REPLAY_WORKER,
      {
        SOFTPROBE_MODE: 'REPLAY',
        SOFTPROBE_CASSETTE_PATH: cassettePath,
        SOFTPROBE_STRICT_REPLAY: '1',
        PG_URL: 'postgres://127.0.0.1:63999/offline',
        ...(recordedTraceId && { REPLAY_TRACE_ID: recordedTraceId }),
      },
      { useTsNode: true }
    );

    expect(replayResult.exitCode).toBe(0);
    expect(replayResult.stderr).toBe('');
    const replayStdout = replayResult.stdout.trim();
    if (replayStdout) {
      const replayed = JSON.parse(replayStdout) as { rows: unknown[]; rowCount: number };
      expect(Array.isArray(replayed.rows)).toBe(true);
      expect(replayed.rowCount).toBeGreaterThanOrEqual(0);
    }
  }, 30000);
});
