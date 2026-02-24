/**
 * User-facing demo: Express app with real Postgres, Redis, and outbound HTTP.
 * Uses OpenTelemetry (started in instrumentation.ts, loaded first). Softprobe init
 * runs when instrumentation is preloaded (CAPTURE/REPLAY modes).
 *
 * Structure aligned with express-inbound-worker: async start(), load cassette and set
 * matcher before creating the app, and use require('express') so framework mutator
 * injects softprobe middleware. Run: npm run example:run (preloads instrumentation).
 * Env: PG_URL, REDIS_URL (defaults match docker-compose), PORT (default 3000), HTTPBIN_URL
 */

import { Client } from 'pg';
import { createClient } from 'redis';
import { softprobe } from '../../src/api';
import { loadNdjson } from '../../src/store/load-ndjson';
import { SoftprobeMatcher } from '../../src/replay/softprobe-matcher';
import { createDefaultMatcher } from '../../src/replay/extract-key';

const DEFAULT_PG_URL = 'postgres://postgres:postgres@localhost:5432/postgres';
const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const HTTPBIN_URL = process.env.HTTPBIN_URL ?? 'https://httpbin.org/get';
const PORT = parseInt(process.env.PORT ?? '3000', 10);

const pgUrl = process.env.PG_URL ?? DEFAULT_PG_URL;
const redisUrl = process.env.REDIS_URL ?? DEFAULT_REDIS_URL;

async function start(): Promise<void> {
  if (process.env.SOFTPROBE_MODE === 'REPLAY') {
    const cassettePath = process.env.SOFTPROBE_CASSETTE_PATH;
    if (!cassettePath) throw new Error('SOFTPROBE_CASSETTE_PATH is required for REPLAY');
    const records = await loadNdjson(cassettePath);
    softprobe.setReplayRecordsCache(records);
    const matcher = new SoftprobeMatcher();
    matcher.use(createDefaultMatcher());
    matcher._setRecords(records); // Prime so single-trace cassette works; middleware refines per request
    softprobe.setGlobalReplayMatcher(matcher);
  }

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
    });
  });

  /** In CAPTURE mode, flush cassette and exit so NDJSON is written. Used by example:capture. */
  app.get('/exit', (_req, res) => {
    res.send('ok');
    if (process.env.SOFTPROBE_MODE === 'CAPTURE') {
      setImmediate(() => {
        softprobe.flushCapture();
        process.exit(0);
      });
    }
  });

  app.listen(PORT, () => {
    console.log(`Listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
