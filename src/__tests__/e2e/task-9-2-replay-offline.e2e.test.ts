/**
 * Task 9.2: Replay E2E runs with dependencies offline.
 * Strict replay must succeed for recorded paths without live DB/Redis/HTTP.
 */

import fs from 'fs';
import path from 'path';
import { runChild, runServer, waitForServer, closeServer } from './run-child';
import { E2eArtifacts } from './helpers/e2e-artifacts';

const EXPRESS_WORKER = path.join(__dirname, 'helpers', 'express-inbound-worker.ts');
const EXPRESS_FIXTURE = path.join(__dirname, 'fixtures', 'express-replay.ndjson');
const PG_REPLAY_WORKER = path.join(__dirname, 'helpers', 'pg-cassette-replay-worker.ts');
const REDIS_REPLAY_WORKER = path.join(__dirname, 'helpers', 'redis-replay-worker.ts');
const FIXTURE_TRACE_ID = '00000000000000000000000000000001';
const PG_TRACE_ID = '00000000000000000000000000000092';
const REDIS_TRACE_ID = '00000000000000000000000000000093';

function writeFixture(pathname: string, lines: string[]): void {
  fs.writeFileSync(pathname, `${lines.join('\n')}\n`, 'utf8');
}

describe('Task 9.2 - replay succeeds with dependencies offline', () => {
  let artifacts: E2eArtifacts;
  let pgCassettePath: string;
  let redisCassettePath: string;
  let redisKey: string;
  let redisValue: string;

  beforeEach(() => {
    artifacts = new E2eArtifacts();
    const now = Date.now();
    pgCassettePath = artifacts.createTempFile('task-9-2-pg', '.ndjson');
    redisCassettePath = artifacts.createTempFile('task-9-2-redis', '.ndjson');
    redisKey = `task9:redis:key:${now}`;
    redisValue = `task9:redis:value:${now}`;

    writeFixture(pgCassettePath, [
      JSON.stringify({
        version: '4.1',
        traceId: PG_TRACE_ID,
        spanId: '0000000000000092',
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'outbound',
        protocol: 'postgres',
        identifier: 'SELECT 1 AS num, $1::text AS label',
        responsePayload: { rows: [{ num: 1, label: 'e2e-cassette' }], rowCount: 1 },
      }),
    ]);

    writeFixture(redisCassettePath, [
      JSON.stringify({
        version: '4.1',
        traceId: REDIS_TRACE_ID,
        spanId: '0000000000000093',
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'outbound',
        protocol: 'redis',
        identifier: `GET ${redisKey}`,
        responsePayload: redisValue,
      }),
    ]);
  });

  afterEach(() => {
    artifacts.cleanup();
  });

  it('strict replay succeeds for recorded HTTP/Postgres/Redis without live dependencies', async () => {
    const fixtureDir = artifacts.createTempDir('task-9-2-http');
    const expressFixtureCopy = path.join(fixtureDir, `${FIXTURE_TRACE_ID}.ndjson`);
    fs.copyFileSync(EXPRESS_FIXTURE, expressFixtureCopy);
    const httpReplayConfigPath = artifacts.createSoftprobeConfig('task-9-2-http-replay', {
      mode: 'REPLAY',
      cassetteDirectory: fixtureDir,
      traceId: FIXTURE_TRACE_ID,
      strictReplay: true,
    });
    const pgReplayConfigPath = artifacts.createSoftprobeConfig('task-9-2-pg-replay', {
      mode: 'REPLAY',
      cassetteDirectory: path.dirname(pgCassettePath),
      traceId: path.basename(pgCassettePath, '.ndjson'),
      strictReplay: true,
    });
    const redisReplayConfigPath = artifacts.createSoftprobeConfig('task-9-2-redis-replay', {
      mode: 'REPLAY',
      cassetteDirectory: path.dirname(redisCassettePath),
      traceId: path.basename(redisCassettePath, '.ndjson'),
      strictReplay: true,
    });

    const httpPort = 30400 + (Date.now() % 10000);
    const httpChild = runServer(
      EXPRESS_WORKER,
      {
        PORT: String(httpPort),
        SOFTPROBE_CONFIG_PATH: httpReplayConfigPath,
      },
      { useTsNode: true }
    );

    try {
      await waitForServer(httpPort, 20000);
      const traceparent = `00-${FIXTURE_TRACE_ID}-0000000000000001-01`;
      const httpRes = await fetch(`http://127.0.0.1:${httpPort}/`, {
        headers: {
          traceparent,
          'x-softprobe-trace-id': FIXTURE_TRACE_ID,
        },
        signal: AbortSignal.timeout(20000),
      });
      expect(httpRes.ok).toBe(true);
      const httpBody = (await httpRes.json()) as { ok?: boolean; outbound?: unknown };
      expect(httpBody.ok).toBe(true);
      expect(httpBody.outbound).toEqual({ url: 'https://httpbin.org/get' });

      await fetch(`http://127.0.0.1:${httpPort}/exit`, { signal: AbortSignal.timeout(5000) }).catch(() => {});
      await new Promise<void>((resolve) => {
        httpChild.once('exit', () => resolve());
        setTimeout(resolve, 5000);
      });
    } finally {
      await closeServer(httpChild);
    }

    const pgReplay = runChild(
      PG_REPLAY_WORKER,
      {
        SOFTPROBE_CONFIG_PATH: pgReplayConfigPath,
        PG_URL: 'postgres://127.0.0.1:63999/offline',
        REPLAY_TRACE_ID: PG_TRACE_ID,
      },
      { useTsNode: true }
    );
    expect(pgReplay.exitCode).toBe(0);
    expect(pgReplay.stderr).toBe('');

    const redisReplay = runChild(
      REDIS_REPLAY_WORKER,
      {
        SOFTPROBE_CONFIG_PATH: redisReplayConfigPath,
        REDIS_KEY: redisKey,
        REPLAY_TRACE_ID: REDIS_TRACE_ID,
      },
      { useTsNode: true }
    );
    expect(redisReplay.exitCode).toBe(0);
    expect(redisReplay.stderr).toBe('');
    const redisPayload = JSON.parse(redisReplay.stdout) as { value: string };
    expect(redisPayload.value).toBe(redisValue);
  }, 60000);
});
