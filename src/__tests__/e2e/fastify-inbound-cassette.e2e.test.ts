/**
 * Task 14.4.3: Fastify capture/replay E2E parity.
 * Test: same route flow in Fastify captures inbound payload and replays without live dependencies.
 */

import fs from 'fs';
import path from 'path';
import { runServer, waitForServer, closeServer } from './run-child';
import { loadCassetteRecordsByPath } from '../helpers/read-cassette-file';
import type { SoftprobeCassetteRecord } from '../../types/schema';
import { E2eArtifacts } from './helpers/e2e-artifacts';

const WORKER_SCRIPT = path.join(__dirname, 'helpers', 'fastify-inbound-worker.ts');
const FIXTURE_CASSETTE = path.join(__dirname, 'fixtures', 'express-replay.ndjson');

/** Disable OTel Fastify instrumentation so our framework mutator's wrapper gets the raw factory (Fastify 5 returns Promise; OTel expects sync). */
const FASTIFY_WORKER_ENV = { OTEL_NODE_DISABLED_INSTRUMENTATIONS: 'fastify' };

/** Known traceId in fixtures/express-replay.ndjson (32 hex lowercase). */
const FIXTURE_TRACE_ID = '00000000000000000000000000000001';

function getInboundRecords(records: SoftprobeCassetteRecord[]): SoftprobeCassetteRecord[] {
  return records.filter((r) => r.type === 'inbound');
}

/** Strip variable http headers so replay comparison is stable. */
function withoutVariableHeaders(obj: unknown): unknown {
  const o = JSON.parse(JSON.stringify(obj));
  if (o && typeof o === 'object' && 'headers' in o && o.headers) delete (o as Record<string, unknown>).headers;
  return o;
}

function getOutboundRecords(records: SoftprobeCassetteRecord[]): SoftprobeCassetteRecord[] {
  return records.filter(
    (r) =>
      r.type === 'outbound' &&
      (r.protocol === 'http' || r.protocol === 'redis' || r.protocol === 'postgres')
  );
}

describe('E2E Fastify inbound cassette (Task 14.4.3)', () => {
  let artifacts: E2eArtifacts;
  let cassettePath: string;
  let capturedTraceId: string;

  beforeAll(() => {
    artifacts = new E2eArtifacts();
    cassettePath = artifacts.createTempFile('fastify-inbound-e2e', '.ndjson');
  });

  afterAll(() => {
    artifacts.cleanup();
  });

  it('CAPTURE writes NDJSON with inbound record and at least one outbound record', async () => {
    const port = 30100 + (Date.now() % 10000);
    const child = runServer(
      WORKER_SCRIPT,
      { ...FASTIFY_WORKER_ENV, PORT: String(port), SOFTPROBE_MODE: 'CAPTURE', SOFTPROBE_CASSETTE_PATH: cassettePath },
      { useTsNode: true }
    );

    try {
      await waitForServer(port, 20000);
      const traceId = path.basename(cassettePath, '.ndjson');
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { 'x-softprobe-trace-id': traceId },
        signal: AbortSignal.timeout(20000),
      });
      expect(res.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 800));
      await fetch(`http://127.0.0.1:${port}/exit`, { signal: AbortSignal.timeout(5000) }).catch(() => {});
      await new Promise<void>((r) => {
        child.once('exit', r);
        setTimeout(r, 5000);
      });
    } finally {
      await closeServer(child);
    }

    expect(fs.existsSync(cassettePath)).toBe(true);
    const records = await loadCassetteRecordsByPath(cassettePath);

    const inbound = getInboundRecords(records);
    expect(inbound.length).toBeGreaterThanOrEqual(1);
    const oneInbound = inbound[0];
    expect(oneInbound.type).toBe('inbound');
    expect(oneInbound.protocol).toBe('http');
    expect(oneInbound.responsePayload).toBeDefined();
    expect((oneInbound.responsePayload as { statusCode?: number }).statusCode).toBe(200);
    expect((oneInbound.responsePayload as { body?: unknown }).body).toBeDefined();

    const outbound = getOutboundRecords(records);
    expect(outbound.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  it('REPLAY + strict with fixture cassette succeeds (no live dependencies)', async () => {
    const fixtureDir = path.join(path.dirname(FIXTURE_CASSETTE), `fastify-fixture-${Date.now()}`);
    fs.mkdirSync(fixtureDir, { recursive: true });
    const fixtureCopyPath = path.join(fixtureDir, `${FIXTURE_TRACE_ID}.ndjson`);
    fs.copyFileSync(FIXTURE_CASSETTE, fixtureCopyPath);

    const port = 30110 + (Date.now() % 10000);
    const child = runServer(
      WORKER_SCRIPT,
      { ...FASTIFY_WORKER_ENV, PORT: String(port), SOFTPROBE_MODE: 'REPLAY', SOFTPROBE_STRICT_REPLAY: '1', SOFTPROBE_CASSETTE_PATH: fixtureCopyPath },
      { useTsNode: true }
    );

    try {
      await waitForServer(port, 20000);
      const traceparent = `00-${FIXTURE_TRACE_ID}-0000000000000001-01`;
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: {
          traceparent,
          'x-softprobe-trace-id': FIXTURE_TRACE_ID,
        },
        signal: AbortSignal.timeout(20000),
      });
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { ok?: boolean; outbound?: unknown };
      expect(body.ok).toBe(true);
      expect(withoutVariableHeaders(body.outbound)).toEqual(withoutVariableHeaders({ url: 'https://httpbin.org/get' }));

      await fetch(`http://127.0.0.1:${port}/exit`, { signal: AbortSignal.timeout(5000) }).catch(() => {});
      await new Promise<void>((r) => {
        child.once('exit', r);
        setTimeout(r, 5000);
      });
    } finally {
      await closeServer(child);
      try {
        fs.unlinkSync(fixtureCopyPath);
        fs.rmdirSync(fixtureDir);
      } catch {
        // ignore cleanup
      }
    }
  }, 30000);

  it('REPLAY + strict succeeds from cassette with dependencies offline', async () => {
    // Capture first to get a cassette with known traceId
    const capturePort = 30120 + (Date.now() % 10000);
    const captureChild = runServer(
      WORKER_SCRIPT,
      { ...FASTIFY_WORKER_ENV, PORT: String(capturePort), SOFTPROBE_MODE: 'CAPTURE', SOFTPROBE_CASSETTE_PATH: cassettePath },
      { useTsNode: true }
    );
    try {
      await waitForServer(capturePort, 20000);
      const traceId = path.basename(cassettePath, '.ndjson');
      await fetch(`http://127.0.0.1:${capturePort}/`, {
        headers: { 'x-softprobe-trace-id': traceId },
        signal: AbortSignal.timeout(20000),
      });
      await fetch(`http://127.0.0.1:${capturePort}/exit`, { signal: AbortSignal.timeout(5000) }).catch(() => {});
      await new Promise<void>((resolve) => {
        captureChild.on('exit', () => resolve());
        setTimeout(resolve, 5000);
      });
    } finally {
      await closeServer(captureChild);
    }

    expect(fs.existsSync(cassettePath)).toBe(true);
    const records = await loadCassetteRecordsByPath(cassettePath);
    const inbound = getInboundRecords(records);
    expect(inbound.length).toBeGreaterThanOrEqual(1);
    capturedTraceId = inbound[0].traceId;
    expect(capturedTraceId).toBeDefined();

    const replayPort = 30130 + (Date.now() % 10000);
    const replayChild = runServer(
      WORKER_SCRIPT,
      { ...FASTIFY_WORKER_ENV, PORT: String(replayPort), SOFTPROBE_MODE: 'REPLAY', SOFTPROBE_STRICT_REPLAY: '1', SOFTPROBE_CASSETTE_PATH: cassettePath },
      { useTsNode: true }
    );

    try {
      await waitForServer(replayPort, 20000);
      const traceIdForFile = path.basename(cassettePath, '.ndjson');
      const traceIdHex = String(capturedTraceId).trim().toLowerCase();
      const traceparent = `00-${traceIdHex}-0000000000000001-01`;
      const res = await fetch(`http://127.0.0.1:${replayPort}/`, {
        headers: {
          traceparent,
          'x-softprobe-trace-id': traceIdForFile,
        },
        signal: AbortSignal.timeout(20000),
      });
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { ok?: boolean; outbound?: unknown };
      expect(body.ok).toBe(true);
      expect(body.outbound).toBeDefined();

      const outboundHttp = records.find(
        (r) => r.traceId === capturedTraceId && r.type === 'outbound' && r.protocol === 'http'
      );
      expect(outboundHttp).toBeDefined();
      const responsePayload = (outboundHttp as SoftprobeCassetteRecord).responsePayload as
        | { body?: unknown }
        | undefined;
      if (responsePayload?.body !== undefined) {
        const expectedBody =
          typeof responsePayload.body === 'string' ? JSON.parse(responsePayload.body) : responsePayload.body;
        expect(withoutVariableHeaders(body.outbound)).toEqual(withoutVariableHeaders(expectedBody));
      }

      await fetch(`http://127.0.0.1:${replayPort}/exit`, { signal: AbortSignal.timeout(5000) }).catch(() => {});
      await new Promise<void>((r) => {
        replayChild.once('exit', r);
        setTimeout(r, 5000);
      });
    } finally {
      await closeServer(replayChild);
    }
  }, 60000);
});
