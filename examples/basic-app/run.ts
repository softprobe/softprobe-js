/**
 * User-facing demo: Express app with real Postgres, Redis, and outbound HTTP.
 * Uses OpenTelemetry (started in instrumentation.ts, loaded first).
 * Add Softprobe later: import "softprobe/init" as the first line in instrumentation.ts.
 *
 * Run: npm run example:run (preloads instrumentation so OTel starts before this file).
 * Env: PG_URL, REDIS_URL (defaults match docker-compose), PORT (default 3000), HTTPBIN_URL
 */

import express from 'express';
import { Client } from 'pg';
import { createClient } from 'redis';

const DEFAULT_PG_URL = 'postgres://postgres:postgres@localhost:5432/postgres';
const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const HTTPBIN_URL = process.env.HTTPBIN_URL ?? 'https://httpbin.org/get';
const PORT = parseInt(process.env.PORT ?? '3000', 10);

const pgUrl = process.env.PG_URL ?? DEFAULT_PG_URL;
const redisUrl = process.env.REDIS_URL ?? DEFAULT_REDIS_URL;

const app = express();

app.get('/', async (_req, res) => {
  const pgClient = new Client({ connectionString: pgUrl });
  await pgClient.connect();
  const pgResult = await pgClient.query('SELECT 1 AS num');
  await pgClient.end();

  const redisClient = createClient({ url: redisUrl });
  await redisClient.connect();
  const key = 'basic-app:example';
  await redisClient.set(key, 'hello');
  const redisValue = await redisClient.get(key);
  await redisClient.quit();

  const httpRes = await fetch(HTTPBIN_URL);
  const httpBody = (await httpRes.json()) as Record<string, unknown>;

  res.json({
    postgres: { rows: pgResult.rows, rowCount: pgResult.rowCount },
    redis: { key, value: redisValue },
    http: httpBody,
  });
});

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
