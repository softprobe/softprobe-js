import fs from 'fs';
import os from 'os';
import path from 'path';

import * as otelApi from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import type { SoftprobeCassetteRecord } from '../types/schema';
import { SoftprobeContext, createTestCassette } from '../context';

beforeAll(() => {
  const contextManager = new AsyncHooksContextManager();
  contextManager.enable();
  otelApi.context.setGlobalContextManager(contextManager);
});

/**
 * Task 13.4: One file per trace — path = {cassetteDirectory}/{traceId}.ndjson
 * Task 13.6: Cassette obtained via SoftprobeContext.run + getCassette() (only context creates instances).
 */
describe('NdjsonCassette one file per trace (Task 13.4)', () => {
  it('uses path {dir}/{traceId}.ndjson for read and write; write then loadTrace returns that record', async () => {
    const cassetteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softprobe-13-4-'));
    try {
      const traceId = 'trace-alpha';
      await SoftprobeContext.run({ mode: 'CAPTURE', traceId, cassetteDirectory: cassetteDir }, async () => {
        const cassette = SoftprobeContext.getCassette()!;
        const record: SoftprobeCassetteRecord = {
          version: '4.1',
          traceId: 'trace-alpha',
          spanId: 'span-1',
          timestamp: '2025-01-01T00:00:00.000Z',
          type: 'outbound',
          protocol: 'http',
          identifier: 'GET /alpha',
        };
        await cassette.saveRecord(record);
        const loaded = await cassette.loadTrace();
        expect(loaded).toHaveLength(1);
        expect(loaded[0].spanId).toBe('span-1');
        expect(loaded[0].identifier).toBe('GET /alpha');
      });
      const expectedPath = path.join(cassetteDir, `${traceId}.ndjson`);
      expect(fs.existsSync(expectedPath)).toBe(true);
    } finally {
      try {
        fs.rmSync(cassetteDir, { recursive: true });
      } catch {
        // ignore cleanup
      }
    }
  });

  it('different traceId uses different file and does not see first trace data', async () => {
    const cassetteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softprobe-13-4-'));
    try {
      await SoftprobeContext.run({ mode: 'CAPTURE', traceId: 'trace-a', cassetteDirectory: cassetteDir }, async () => {
        const cassetteA = SoftprobeContext.getCassette()!;
        const recordA: SoftprobeCassetteRecord = {
          version: '4.1',
          traceId: 'trace-a',
          spanId: 'span-a',
          timestamp: '2025-01-01T00:00:00.000Z',
          type: 'outbound',
          protocol: 'http',
          identifier: 'GET /a',
        };
        await cassetteA.saveRecord(recordA);
      });
      await SoftprobeContext.run({ mode: 'CAPTURE', traceId: 'trace-b', cassetteDirectory: cassetteDir }, async () => {
        const cassetteB = SoftprobeContext.getCassette()!;
        const recordB: SoftprobeCassetteRecord = {
          version: '4.1',
          traceId: 'trace-b',
          spanId: 'span-b',
          timestamp: '2025-01-01T00:00:00.000Z',
          type: 'outbound',
          protocol: 'http',
          identifier: 'GET /b',
        };
        await cassetteB.saveRecord(recordB);
      });
      let loadedA: SoftprobeCassetteRecord[] = [];
      let loadedB: SoftprobeCassetteRecord[] = [];
      await SoftprobeContext.run({ mode: 'REPLAY', traceId: 'trace-a', cassetteDirectory: cassetteDir }, async () => {
        loadedA = await SoftprobeContext.getCassette()!.loadTrace();
      });
      await SoftprobeContext.run({ mode: 'REPLAY', traceId: 'trace-b', cassetteDirectory: cassetteDir }, async () => {
        loadedB = await SoftprobeContext.getCassette()!.loadTrace();
      });
      expect(loadedA).toHaveLength(1);
      expect(loadedA[0].spanId).toBe('span-a');
      expect(loadedB).toHaveLength(1);
      expect(loadedB[0].spanId).toBe('span-b');
      const files = fs.readdirSync(cassetteDir).sort();
      expect(files).toEqual(['trace-a.ndjson', 'trace-b.ndjson']);
    } finally {
      try {
        fs.rmSync(cassetteDir, { recursive: true });
      } catch {
        // ignore cleanup
      }
    }
  });
});

describe('NdjsonCassette.loadTrace (Task 13.3: no traceId param)', () => {
  it('returns all records from the cassette file', async () => {
    const cassetteDir = path.join(__dirname, 'fixtures');
    const traceId = 'ndjson-cassette-load-trace';
    let records: SoftprobeCassetteRecord[] = [];
    await SoftprobeContext.run(
      { mode: 'REPLAY', traceId, cassetteDirectory: cassetteDir },
      async () => {
        records = await SoftprobeContext.getCassette()!.loadTrace();
      }
    );
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.spanId)).toEqual(['span-1', 'span-2', 'span-3']);
  });
});

describe('NdjsonCassette.saveRecord', () => {
  it('appends one NDJSON line for one saved record', async () => {
    const cassetteDir = os.tmpdir();
    const traceId = `softprobe-ndjson-cassette-${Date.now()}`;
    await SoftprobeContext.run({ mode: 'CAPTURE', traceId, cassetteDirectory: cassetteDir }, async () => {
      const cassette = SoftprobeContext.getCassette()!;
      const record: SoftprobeCassetteRecord = {
        version: '4.1',
        traceId: 'trace-append',
        spanId: 'span-append',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'outbound',
        protocol: 'http',
        identifier: 'GET /append-test',
      };
      await cassette.saveRecord(record);
    });
    const tmpPath = path.join(cassetteDir, `${traceId}.ndjson`);
    const content = fs.readFileSync(tmpPath, 'utf8');
    const lines = content.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]) as SoftprobeCassetteRecord).spanId).toBe('span-append');
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup
    }
  });
});

describe('NdjsonCassette.flush', () => {
  it('is a no-op for direct-write implementation', async () => {
    const cassette = createTestCassette(os.tmpdir(), 'unused');
    await expect(cassette.flush?.()).resolves.toBeUndefined();
  });
});
