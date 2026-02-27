/**
 * Basic-app example: Postgres, Redis, and upstream HTTP — capture and replay.
 *
 * How to run (design §4.1: softprobe/init must run first):
 *   node -r ./instrumentation.ts run.ts
 * instrumentation.ts imports softprobe/init before OpenTelemetry, so capture/replay
 * and the Express middleware are active. From repo root: npm run example:run
 *
 * This app demonstrates:
 * - Capture: request with x-softprobe-mode: CAPTURE + x-softprobe-trace-id
 *   records inbound GET / and outbound Postgres, Redis, and HTTP to {cassetteDirectory}/{traceId}.ndjson.
 * - Replay: run with YAML config (mode PASSTHROUGH or REPLAY and cassetteDirectory); GET / is
 *   served from the cassette when the request has replay headers (e.g. from softprobe diff).
 *
 * Use require('express') so the framework mutator injects Softprobe middleware.
 * Env: PG_URL, REDIS_URL (defaults match docker-compose), PORT (default 3000), HTTPBIN_URL.
 *
 * Optional regression demo (Task 12.4): SOFTPROBE_DEMO_BUG=1 changes a business field so
 * softprobe diff fails deterministically (capture baseline -> enable bug -> diff fails).
 */

import { Client } from 'pg';
import { createClient } from 'redis';

const DEFAULT_PG_URL = 'postgres://postgres:postgres@localhost:5432/postgres';
const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const HTTPBIN_URL = process.env.HTTPBIN_URL ?? 'https://httpbin.org/get';
const PORT = parseInt(process.env.PORT ?? '3000', 10);

const pgUrl = process.env.PG_URL ?? DEFAULT_PG_URL;
const redisUrl = process.env.REDIS_URL ?? DEFAULT_REDIS_URL;

/** Example-only: when set, response changes so softprobe diff fails (business regression demo). */
const demoBugEnabled = process.env.SOFTPROBE_DEMO_BUG === '1' || process.env.SOFTPROBE_DEMO_BUG === 'true';

async function start(): Promise<void> {
  // REPLAY: init (from instrumentation) sets mode and cassetteDirectory; middleware creates matcher per request via SoftprobeContext.run(REPLAY). No user-created matcher or global cache.

  const express = require('express') as typeof import('express');
  const app = express();

  /** Lightweight readiness check; no outbound calls. Used by replay-runner waitForServer. */
  app.get('/ping', (_req, res) => {
    res.send('ok');
  });

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
      /** Example-only: changes when SOFTPROBE_DEMO_BUG=1 so diff fails (regression demo). */
      businessRegressionDemo: demoBugEnabled ? 'buggy' : 'baseline',
    });
  });

  /** Exit after responding; used by example:capture so the process exits after flush. */
  app.get('/exit', (_req, res) => {
    res.send('ok');
    setImmediate(() => process.exit(0));
  });

  app.listen(PORT, () => {
    console.log(`Listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
