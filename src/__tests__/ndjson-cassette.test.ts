import fs from 'fs';
import os from 'os';
import path from 'path';

import type { SoftprobeCassetteRecord } from '../types/schema';
import { NdjsonCassette } from '../core/cassette/ndjson-cassette';

/**
 * Task 13.4: One file per trace — path = {cassetteDirectory}/{traceId}.ndjson
 */
describe('NdjsonCassette one file per trace (Task 13.4)', () => {
  it('uses path {dir}/{traceId}.ndjson for read and write; write then loadTrace returns that record', async () => {
    const cassetteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softprobe-13-4-'));
    try {
      const traceId = 'trace-alpha';
      const cassette = new NdjsonCassette(cassetteDir, traceId);
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
      const cassetteA = new NdjsonCassette(cassetteDir, 'trace-a');
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

      const cassetteB = new NdjsonCassette(cassetteDir, 'trace-b');
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

      const loadedA = await cassetteA.loadTrace();
      const loadedB = await cassetteB.loadTrace();

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
    const cassette = new NdjsonCassette(cassetteDir, traceId);

    const records = await cassette.loadTrace();

    expect(records).toHaveLength(3);
    expect(records.map((r) => r.spanId)).toEqual(['span-1', 'span-2', 'span-3']);
  });
});

describe('NdjsonCassette.saveRecord', () => {
  it('appends one NDJSON line for one saved record', async () => {
    const cassetteDir = os.tmpdir();
    const traceId = `softprobe-ndjson-cassette-${Date.now()}`;
    const cassette = new NdjsonCassette(cassetteDir, traceId);
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
  it('delegates to underlying writer flush when available', async () => {
    const flush = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const cassette = new NdjsonCassette(os.tmpdir(), 'unused', { flush });

    await cassette.flush?.();

    expect(flush).toHaveBeenCalledTimes(1);
  });
});
