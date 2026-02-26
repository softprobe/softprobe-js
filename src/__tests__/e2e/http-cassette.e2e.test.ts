/**
 * Task 12.4 HTTP E2E:
 * - 12.4.1 CAPTURE writes NDJSON
 * - 12.4.2 REPLAY runs with network disabled (no live server)
 */

import fs from 'fs';
import path from 'path';
import { runChild, runServer, waitForServer, closeServer } from './run-child';
import { loadCassetteRecordsByPath } from '../helpers/read-cassette-file';
import type { SoftprobeCassetteRecord } from '../../types/schema';
import { E2eArtifacts } from './helpers/e2e-artifacts';

// Child process that performs a real outbound fetch in CAPTURE mode and flushes cassette writes.
const CAPTURE_WORKER = path.join(__dirname, 'helpers', 'http-cassette-capture-worker.ts');
// Child process that runs REPLAY mode and issues the same fetch, expecting a mocked response from cassette.
const REPLAY_WORKER = path.join(__dirname, 'helpers', 'http-replay-worker.ts');
// Local deterministic HTTP server used only during capture to provide a stable payload fixture.
const PROBE_WORKER = path.join(__dirname, 'helpers', 'network-probe-server.ts');

function getHttpOutboundRecords(records: SoftprobeCassetteRecord[]): SoftprobeCassetteRecord[] {
  return records.filter((r) => r.type === 'outbound' && r.protocol === 'http');
}

describe('E2E HTTP cassette capture/replay (Task 12.4)', () => {
  let artifacts: E2eArtifacts;
  let cassettePath: string;
  let captureConfigPath: string;
  let replayConfigPath: string;
  let recordedUrl = '';
  let recordedBody = '';
  let recordedTraceId = '';

  beforeAll(() => {
    artifacts = new E2eArtifacts();
    cassettePath = artifacts.createTempFile('softprobe-e2e-cassette-http', '.ndjson');
    captureConfigPath = artifacts.createTempFile('softprobe-e2e-http-capture', '.yml');
    replayConfigPath = artifacts.createTempFile('softprobe-e2e-http-replay', '.yml');
  });

  afterAll(() => {
    artifacts.cleanup();
  });

  it('12.4.1: CAPTURE writes NDJSON', async () => {
    const probePort = 31700 + (Date.now() % 10000);
    const probeChild = runServer(
      PROBE_WORKER,
      { PORT: String(probePort) },
      { useTsNode: true }
    );
    try {
      await waitForServer(probePort, 20000);
      const captureUrl = `http://127.0.0.1:${probePort}/payload`;
      fs.writeFileSync(
        captureConfigPath,
        `mode: CAPTURE\ncassettePath: ${JSON.stringify(cassettePath)}\n`,
        'utf8'
      );
      const result = runChild(
        CAPTURE_WORKER,
        {
          SOFTPROBE_CONFIG_PATH: captureConfigPath,
          CAPTURE_URL: captureUrl,
        },
        { useTsNode: true }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');

      const captureOut = JSON.parse(result.stdout) as {
        url: string;
        status: number;
        body: string;
        hasLegacyModeEnv: boolean;
        hasLegacyCassetteEnv: boolean;
      };
      recordedUrl = captureOut.url;
      expect(captureOut.hasLegacyModeEnv).toBe(false);
      expect(captureOut.hasLegacyCassetteEnv).toBe(false);

      expect(fs.existsSync(cassettePath)).toBe(true);
      const records = await loadCassetteRecordsByPath(cassettePath);
      const httpRecords = getHttpOutboundRecords(records);
      expect(httpRecords.length).toBeGreaterThanOrEqual(1);

      const targetIdentifier = `GET ${captureOut.url}`;
      const targetRecord = httpRecords.find((r) => r.identifier === targetIdentifier);

      expect(targetRecord).toBeDefined();
      recordedTraceId = targetRecord?.traceId ?? '';
      const payload = (targetRecord?.responsePayload ?? {}) as { statusCode?: number; body?: string };
      expect(payload.statusCode).toBe(captureOut.status);
      expect(payload.body).toBe(captureOut.body);
      recordedBody = captureOut.body;
    } finally {
      await closeServer(probeChild);
    }
  }, 60000);

  it('12.4.2: REPLAY runs with network disabled (no live server)', async () => {
    const recordedPort = new URL(recordedUrl).port;
    const replayProbeChild = runServer(
      PROBE_WORKER,
      { PORT: recordedPort, PROBE_SOURCE: 'probe-replacement' },
      { useTsNode: true }
    );

    fs.writeFileSync(
      replayConfigPath,
      `mode: REPLAY\ncassettePath: ${JSON.stringify(cassettePath)}\n`,
      'utf8'
    );
    try {
      await waitForServer(parseInt(recordedPort, 10), 20000);
      const resetRes = await fetch(`http://127.0.0.1:${recordedPort}/reset`, { method: 'POST' });
      expect(resetRes.ok).toBe(true);
      const preHitsRes = await fetch(`http://127.0.0.1:${recordedPort}/hits`);
      expect(preHitsRes.ok).toBe(true);
      const preHitsPayload = (await preHitsRes.json()) as { hitCount?: number };
      expect(preHitsPayload.hitCount).toBe(0);

      const result = runChild(
        REPLAY_WORKER,
        {
          SOFTPROBE_CONFIG_PATH: replayConfigPath,
          REPLAY_URL: recordedUrl,
          ...(recordedTraceId && { REPLAY_TRACE_ID: recordedTraceId }),
        },
        { useTsNode: true }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');

      const replayOut = JSON.parse(result.stdout) as {
        status: number;
        body: string;
        hasLegacyModeEnv: boolean;
        hasLegacyCassetteEnv: boolean;
      };
      expect(replayOut.status).toBe(200);
      expect(replayOut.body).toBe(recordedBody);
      expect(replayOut.hasLegacyModeEnv).toBe(false);
      expect(replayOut.hasLegacyCassetteEnv).toBe(false);

      const replayBody = JSON.parse(replayOut.body) as { source?: string; method?: string; url?: string };
      expect(replayBody.source).toBe('probe-static');
      expect(replayBody.method).toBe('GET');
      expect(replayBody.url).toBe('/payload');

      const hitsRes = await fetch(`http://127.0.0.1:${recordedPort}/hits`);
      expect(hitsRes.ok).toBe(true);
      const hitsPayload = (await hitsRes.json()) as { hitCount?: number };
      expect(hitsPayload.hitCount).toBe(0);

      const records = await loadCassetteRecordsByPath(cassettePath);
      const outbound = records
        .find((r) => r.type === 'outbound' && r.protocol === 'http' && r.identifier === `GET ${recordedUrl}`);
      expect(outbound).toBeDefined();
      expect(outbound?.identifier).toBe(`GET ${recordedUrl}`);

      const outboundPayload = (outbound?.responsePayload ?? {}) as { body?: string };
      const outboundBody = typeof outboundPayload.body === 'string'
        ? JSON.parse(outboundPayload.body) as { source?: string; method?: string; url?: string }
        : undefined;
      expect(outboundBody?.source).toBe('probe-static');
      expect(outboundBody?.method).toBe('GET');
      expect(outboundBody?.url).toBe('/payload');
    } finally {
      await closeServer(replayProbeChild);
    }
  }, 60000);
});
