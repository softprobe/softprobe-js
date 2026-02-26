/**
 * Task 9.1: Capture E2E writes inbound+outbound NDJSON via cassette interface.
 * Boot in PASSTHROUGH, then request-level CAPTURE headers provide cassette and trace scope.
 */

import fs from 'fs';
import path from 'path';
import { runServer, waitForServer, closeServer } from './run-child';
import { loadNdjson } from '../../store/load-ndjson';
import type { SoftprobeCassetteRecord } from '../../types/schema';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const WORKER_SCRIPT = path.join(__dirname, 'helpers', 'express-inbound-worker.ts');
const OUTBOUND_WORKER_SCRIPT = path.join(__dirname, 'helpers', 'diff-headers-server.ts');

function byTrace(records: SoftprobeCassetteRecord[], traceId: string): SoftprobeCassetteRecord[] {
  return records.filter((r) => r.traceId === traceId);
}

describe('Task 9.1 - Capture E2E via cassette interface', () => {
  let cassettePath: string;

  beforeEach(() => {
    cassettePath = path.join(PROJECT_ROOT, `task-9-1-${Date.now()}.ndjson`);
    if (fs.existsSync(cassettePath)) fs.unlinkSync(cassettePath);
  });

  afterEach(() => {
    if (fs.existsSync(cassettePath)) fs.unlinkSync(cassettePath);
  });

  it('writes inbound and outbound records for one trace using request-scoped cassette', async () => {
    const outboundPort = 31200 + (Date.now() % 10000);
    const outboundChild = runServer(
      OUTBOUND_WORKER_SCRIPT,
      { PORT: String(outboundPort) },
      { useTsNode: true }
    );

    const port = 30200 + (Date.now() % 10000);
    const traceId = '9f1dcb4b9f5f4f52b7c91de2be5db5fd';
    const child = runServer(
      WORKER_SCRIPT,
      {
        PORT: String(port),
        SOFTPROBE_MODE: 'PASSTHROUGH',
        SOFTPROBE_E2E_OUTBOUND_URL: `http://127.0.0.1:${outboundPort}/diff-headers`,
      },
      { useTsNode: true }
    );

    try {
      await waitForServer(outboundPort, 20000);
      await waitForServer(port, 20000);
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: {
          'x-softprobe-mode': 'CAPTURE',
          'x-softprobe-cassette-path': cassettePath,
          'x-softprobe-trace-id': traceId,
        },
        signal: AbortSignal.timeout(20000),
      });
      expect(res.ok).toBe(true);
      await fetch(`http://127.0.0.1:${port}/exit`, { signal: AbortSignal.timeout(5000) }).catch(() => {});
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(resolve, 5000);
      });
    } finally {
      await closeServer(outboundChild);
      await closeServer(child);
    }

    expect(fs.existsSync(cassettePath)).toBe(true);
    const records = await loadNdjson(cassettePath);
    const traceRecords = byTrace(records, traceId);

    expect(traceRecords.length).toBeGreaterThanOrEqual(2);
    const inbound = traceRecords.find((r) => r.type === 'inbound' && r.protocol === 'http');
    const outbound = traceRecords.find((r) => r.type === 'outbound' && r.protocol === 'http');

    expect(inbound).toBeDefined();
    expect(outbound).toBeDefined();
  }, 30000);
});
