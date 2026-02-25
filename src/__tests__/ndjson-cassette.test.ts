import fs from 'fs';
import os from 'os';
import path from 'path';

import type { SoftprobeCassetteRecord } from '../types/schema';
import { NdjsonCassette } from '../core/cassette/ndjson-cassette';

describe('NdjsonCassette.loadTrace', () => {
  it('returns only records matching the requested traceId from NDJSON fixture', async () => {
    const fixturePath = path.join(
      __dirname,
      'fixtures',
      'ndjson-cassette-load-trace.ndjson'
    );
    const cassette = new NdjsonCassette(fixturePath);

    const records = await cassette.loadTrace('trace-a');

    expect(records).toHaveLength(2);
    expect(records.every((record) => record.traceId === 'trace-a')).toBe(true);
    expect(records.map((record) => record.spanId)).toEqual(['span-1', 'span-3']);
  });
});

describe('NdjsonCassette.saveRecord', () => {
  it('appends one NDJSON line for one saved record', async () => {
    const tmpPath = path.join(os.tmpdir(), `softprobe-ndjson-cassette-${Date.now()}.ndjson`);
    const cassette = new NdjsonCassette(tmpPath);
    const record: SoftprobeCassetteRecord = {
      version: '4.1',
      traceId: 'trace-append',
      spanId: 'span-append',
      timestamp: '2025-01-01T00:00:00.000Z',
      type: 'outbound',
      protocol: 'http',
      identifier: 'GET /append-test',
    };

    await cassette.saveRecord('trace-append', record);

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
    const cassette = new NdjsonCassette('unused.ndjson', { flush });

    await cassette.flush?.();

    expect(flush).toHaveBeenCalledTimes(1);
  });
});
