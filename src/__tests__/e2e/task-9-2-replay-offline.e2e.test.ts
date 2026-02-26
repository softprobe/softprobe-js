/**
 * Task 9.2: Replay E2E runs with dependencies offline.
 * Strict replay must succeed for recorded paths without live DB/Redis/HTTP.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { runChild, runServer, waitForServer, closeServer } from './run-child';

const EXPRESS_WORKER = path.join(__dirname, 'helpers', 'express-inbound-worker.ts');
const EXPRESS_FIXTURE = path.join(__dirname, 'fixtures', 'express-replay.ndjson');
const PG_REPLAY_WORKER = path.join(__dirname, 'helpers', 'pg-cassette-replay-worker.ts');
const REDIS_REPLAY_WORKER = path.join(__dirname, 'helpers', 'redis-replay-worker.ts');
const FIXTURE_TRACE_ID = '00000000000000000000000000000001';

function writeFixture(pathname: string, lines: string[]): void {
  fs.writeFileSync(pathname, `${lines.join('\n')}\n`, 'utf8');
}

describe('Task 9.2 - replay succeeds with dependencies offline', () => {
  let pgCassettePath: string;
  let redisCassettePath: string;
  let redisKey: string;
  let redisValue: string;

  beforeEach(() => {
    const now = Date.now();
    pgCassettePath = path.join(os.tmpdir(), `task-9-2-pg-${now}.ndjson`);
    redisCassettePath = path.join(os.tmpdir(), `task-9-2-redis-${now}.ndjson`);
    redisKey = `task9:redis:key:${now}`;
    redisValue = `task9:redis:value:${now}`;

    writeFixture(pgCassettePath, [
      JSON.stringify({
        version: '4.1',
        traceId: '00000000000000000000000000000092',
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
        traceId: '00000000000000000000000000000093',
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
    if (fs.existsSync(pgCassettePath)) fs.unlinkSync(pgCassettePath);
    if (fs.existsSync(redisCassettePath)) fs.unlinkSync(redisCassettePath);
  });

  it('strict replay succeeds for recorded HTTP/Postgres/Redis without live dependencies', async () => {
    const httpPort = 30400 + (Date.now() % 10000);
    const httpChild = runServer(
      EXPRESS_WORKER,
      {
        PORT: String(httpPort),
        SOFTPROBE_MODE: 'REPLAY',
        SOFTPROBE_STRICT_REPLAY: '1',
        SOFTPROBE_CASSETTE_PATH: EXPRESS_FIXTURE,
      },
      { useTsNode: true }
    );

    try {
      await waitForServer(httpPort, 20000);
      const traceparent = `00-${FIXTURE_TRACE_ID}-0000000000000001-01`;
      const httpRes = await fetch(`http://127.0.0.1:${httpPort}/`, {
        headers: { traceparent },
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
        SOFTPROBE_MODE: 'REPLAY',
        SOFTPROBE_STRICT_REPLAY: '1',
        SOFTPROBE_CASSETTE_PATH: pgCassettePath,
        PG_URL: 'postgres://127.0.0.1:63999/offline',
      },
      { useTsNode: true }
    );
    expect(pgReplay.exitCode).toBe(0);
    expect(pgReplay.stderr).toBe('');

    const redisReplay = runChild(
      REDIS_REPLAY_WORKER,
      {
        SOFTPROBE_MODE: 'REPLAY',
        SOFTPROBE_STRICT_REPLAY: '1',
        SOFTPROBE_CASSETTE_PATH: redisCassettePath,
        REDIS_KEY: redisKey,
      },
      { useTsNode: true }
    );
    expect(redisReplay.exitCode).toBe(0);
    expect(redisReplay.stderr).toBe('');
    const redisPayload = JSON.parse(redisReplay.stdout) as { value: string };
    expect(redisPayload.value).toBe(redisValue);
  }, 60000);
});
