/**
 * Task 16.3.1: Replay runner E2E.
 * Test: with services stopped, replay run still succeeds and output matches snapshot
 * (i.e. matches the response from a prior capture run).
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { runServer, waitForServer, closeServer } from './run-child';
import { loadNdjson } from '../../../src/store/load-ndjson';

const RUN_SCRIPT = path.join(__dirname, '..', 'run.ts');
const INSTRUMENTATION = path.join(__dirname, '..', 'instrumentation.ts');
const REPLAY_RUNNER = path.join(__dirname, '..', 'replay-runner.ts');
const EXAMPLE_DIR = path.join(__dirname, '..');

describe('Replay demo (Task 16.3.1)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let cassettePath: string;
  let captureResponse: Record<string, unknown>;
  let traceId: string;
  const PORT_CAPTURE = 39310;
  const PORT_REPLAY = 39311;

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:16').start();
    redisContainer = await new RedisContainer('redis:7').start();
    const cassetteBasename = `basic-app-replay-${Date.now()}.ndjson`;
    cassettePath = path.join(EXAMPLE_DIR, cassetteBasename);

    const child = runServer(
      RUN_SCRIPT,
      {
        PORT: String(PORT_CAPTURE),
        SOFTPROBE_MODE: 'CAPTURE',
        SOFTPROBE_CASSETTE_PATH: cassetteBasename,
        PG_URL: pgContainer.getConnectionUri(),
        REDIS_URL: redisContainer.getConnectionUrl(),
      },
      { useTsNode: true, require: INSTRUMENTATION }
    );

    try {
      await waitForServer(PORT_CAPTURE, 20000);
      const res = await fetch(`http://127.0.0.1:${PORT_CAPTURE}/`);
      expect(res.ok).toBe(true);
      captureResponse = (await res.json()) as Record<string, unknown>;
      await fetch(`http://127.0.0.1:${PORT_CAPTURE}/exit`).catch(() => {});
      await new Promise<void>((r) => {
        child.once('exit', r);
        setTimeout(() => r(), 15000);
      });
    } finally {
      await closeServer(child);
    }

    expect(fs.existsSync(cassettePath)).toBe(true);
    const records = await loadNdjson(cassettePath);
    expect(records.length).toBeGreaterThanOrEqual(1);
    traceId = records[0].traceId;
    expect(traceId).toBeDefined();
  }, 60000);

  afterAll(async () => {
    await pgContainer?.stop();
    await redisContainer?.stop();
    try {
      if (cassettePath && fs.existsSync(cassettePath)) fs.unlinkSync(cassettePath);
    } catch {
      // ignore
    }
  });

  it('with services stopped, replay run succeeds and output matches capture', async () => {
    await pgContainer.stop();
    await redisContainer.stop();

    const result = spawnSync(
      'npx',
      [
        'ts-node',
        '--transpile-only',
        path.basename(REPLAY_RUNNER),
      ],
      {
        encoding: 'utf-8',
        cwd: EXAMPLE_DIR,
        env: {
          ...process.env,
          SOFTPROBE_MODE: 'REPLAY',
          SOFTPROBE_STRICT_REPLAY: '1',
          SOFTPROBE_CASSETTE_PATH: cassettePath,
          SOFTPROBE_TRACE_ID: traceId,
          PORT: String(PORT_REPLAY),
        },
      }
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBeDefined();
    const out = result.stdout?.trim() ?? '';
    expect(out).toBeTruthy();
    const replayOutput = JSON.parse(out) as Record<string, unknown>;
    expect(replayOutput).toHaveProperty('postgres');
    expect(replayOutput).toHaveProperty('redis');
    expect(replayOutput).toHaveProperty('http');
    expect(replayOutput.postgres).toEqual(captureResponse.postgres);
    expect(replayOutput.redis).toEqual(captureResponse.redis);
    expect((replayOutput.http as Record<string, unknown>).url).toEqual(
      (captureResponse.http as Record<string, unknown>)?.url
    );
  }, 30000);
});
