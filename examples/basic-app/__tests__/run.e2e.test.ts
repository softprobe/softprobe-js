/**
 * E2E tests for the basic-app example (Task 14.1).
 * 14.1.1: GET / returns JSON with postgres, redis, http.
 * 14.1.2: http field reflects deterministic outbound call (httpbin.org).
 *
 * Runs with Testcontainers when executed from repo root (npm run example:test).
 */

import path from 'path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { runServer, waitForServer } from './run-child';

const RUN_SCRIPT = path.join(__dirname, '..', 'run.ts');
const INSTRUMENTATION = path.join(__dirname, '..', 'instrumentation.ts');
const PORT_A = 39281;
const PORT_B = 39282;

describe('Basic-app example E2E', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:16').start();
    redisContainer = await new RedisContainer('redis:7').start();
  }, 60000);

  afterAll(async () => {
    await pgContainer?.stop();
    await redisContainer?.stop();
  });

  it('14.1.1: GET / returns JSON with postgres, redis, http', async () => {
    const child = runServer(
      RUN_SCRIPT,
      {
        PG_URL: pgContainer.getConnectionUri(),
        REDIS_URL: redisContainer.getConnectionUrl(),
        PORT: String(PORT_A),
      },
      { useTsNode: true, require: INSTRUMENTATION }
    );

    try {
      await waitForServer(PORT_A);
      const res = await fetch(`http://127.0.0.1:${PORT_A}/`);
      expect(res.ok).toBe(true);

      const json = (await res.json()) as Record<string, unknown>;
      expect(json).toHaveProperty('postgres');
      expect(json).toHaveProperty('redis');
      expect(json).toHaveProperty('http');
    } finally {
      child.kill();
    }
  });

  it('14.1.2: http field from deterministic outbound call (httpbin.org)', async () => {
    const child = runServer(
      RUN_SCRIPT,
      {
        PG_URL: pgContainer.getConnectionUri(),
        REDIS_URL: redisContainer.getConnectionUrl(),
        PORT: String(PORT_B),
      },
      { useTsNode: true, require: INSTRUMENTATION }
    );

    try {
      await waitForServer(PORT_B);
      const res = await fetch(`http://127.0.0.1:${PORT_B}/`);
      expect(res.ok).toBe(true);

      const json = (await res.json()) as Record<string, unknown>;
      expect(json).toHaveProperty('http');
      const http = json.http as Record<string, unknown>;
      expect(http).toHaveProperty('url');
      expect(String(http.url)).toMatch(/httpbin\.org/);
    } finally {
      child.kill();
    }
  });
});
