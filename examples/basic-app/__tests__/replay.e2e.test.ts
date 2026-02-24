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
    // Stop dependencies so replay must use cassette only (no live pg/redis/http).
    await pgContainer.stop();
    await redisContainer.stop();
    const cassettePathForChild = path.isAbsolute(cassettePath) ? cassettePath : path.resolve(EXAMPLE_DIR, cassettePath);

    // Start server in REPLAY; hit GET / with traceparent so middleware primes matcher by traceId.
    const replayChild = runServer(
      RUN_SCRIPT,
      {
        PORT: String(PORT_REPLAY),
        SOFTPROBE_MODE: 'REPLAY',
        SOFTPROBE_STRICT_REPLAY: '1',
        SOFTPROBE_CASSETTE_PATH: cassettePathForChild,
      },
      { useTsNode: true, require: INSTRUMENTATION }
    );

    const traceparent = `00-${String(traceId).trim().toLowerCase().replace(/-/g, '').padStart(32, '0').slice(-32)}-0000000000000001-01`;
    try {
      await waitForServer(PORT_REPLAY, 20000, '/ping');
      const res = await fetch(`http://127.0.0.1:${PORT_REPLAY}/`, {
        headers: { traceparent },
      });
      expect(res.ok).toBe(true);
      const replayOutput = (await res.json()) as Record<string, unknown>;
      expect(replayOutput).toHaveProperty('postgres');
      expect(replayOutput).toHaveProperty('redis');
      expect(replayOutput).toHaveProperty('http');
      expect(replayOutput.postgres).toEqual(captureResponse.postgres);
      expect(replayOutput.redis).toEqual(captureResponse.redis);
      expect((replayOutput.http as Record<string, unknown>).url).toEqual(
        (captureResponse.http as Record<string, unknown>)?.url
      );
    } finally {
      await closeServer(replayChild);
    }
  }, 30000);

  it('replay-runner script exits 0 and stdout is JSON (npm run example:replay)', async () => {
    // With services stopped, run the replay-runner script as a subprocess; assert exit 0 and JSON stdout.
    await pgContainer.stop();
    await redisContainer.stop();

    const result = spawnSync(
      'npx',
      ['ts-node', '--transpile-only', path.basename(REPLAY_RUNNER)],
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
    const out = result.stdout?.trim() ?? '';
    expect(out).toBeTruthy();
    const replayOutput = JSON.parse(out) as Record<string, unknown>;
    expect(replayOutput).toHaveProperty('postgres');
    expect(replayOutput).toHaveProperty('redis');
    expect(replayOutput).toHaveProperty('http');
  }, 30000);
});
