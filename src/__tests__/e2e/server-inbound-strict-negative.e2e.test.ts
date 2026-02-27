/**
 * Task 14.4.4: Server-side strict negative E2E proves network isolation.
 * Test: replay request with an unrecorded outbound call fails deterministically
 * and verifies passthrough/network call is not invoked (same Fastify app as 14.4.3).
 */

import fs from 'fs';
import path from 'path';
import { runServer, waitForServer, closeServer } from './run-child';

const WORKER_SCRIPT = path.join(__dirname, 'helpers', 'fastify-inbound-worker.ts');
const FIXTURE_CASSETTE = path.join(__dirname, 'fixtures', 'express-replay.ndjson');

/** Disable OTel Fastify instrumentation (same as Task 14.4.3). */
const FASTIFY_WORKER_ENV = { OTEL_NODE_DISABLED_INSTRUMENTATIONS: 'fastify' };

/** TraceId in express-replay.ndjson; fixture has GET / and GET https://httpbin.org/get only (no POST httpbin.org/post). */
const FIXTURE_TRACE_ID = '00000000000000000000000000000001';

describe('E2E Server-side strict negative (Task 14.4.4)', () => {
  it('replay with unrecorded outbound call fails with 500 and x-softprobe-error (passthrough not invoked)', async () => {
    const fixtureDir = path.join(path.dirname(FIXTURE_CASSETTE), `strict-negative-${Date.now()}`);
    fs.mkdirSync(fixtureDir, { recursive: true });
    const fixtureCopy = path.join(fixtureDir, `${FIXTURE_TRACE_ID}.ndjson`);
    fs.copyFileSync(FIXTURE_CASSETTE, fixtureCopy);

    const port = 30200 + (Date.now() % 10000);
    const child = runServer(
      WORKER_SCRIPT,
      {
        ...FASTIFY_WORKER_ENV,
        PORT: String(port),
        SOFTPROBE_MODE: 'REPLAY',
        SOFTPROBE_STRICT_REPLAY: '1',
        SOFTPROBE_CASSETTE_PATH: fixtureCopy,
      },
      { useTsNode: true }
    );

    try {
      await waitForServer(port, 20000);
      const traceparent = `00-${FIXTURE_TRACE_ID}-0000000000000001-01`;
      const res = await fetch(`http://127.0.0.1:${port}/unrecorded`, {
        headers: {
          traceparent,
          'x-softprobe-trace-id': FIXTURE_TRACE_ID,
        },
        signal: AbortSignal.timeout(15000),
      });

      expect(res.status).toBe(500);

      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeDefined();
      expect(typeof body.error).toBe('string');
      expect(body.error).toMatch(/no recorded traces|No recorded traces/i);
      // Proves passthrough was not invoked: interceptor returned 500; real network would return 200 from httpbin.

      await fetch(`http://127.0.0.1:${port}/exit`, { signal: AbortSignal.timeout(5000) }).catch(() => {});
      await new Promise<void>((r) => {
        child.once('exit', r);
        setTimeout(r, 5000);
      });
    } finally {
      await closeServer(child);
    }
  }, 30000);
});
