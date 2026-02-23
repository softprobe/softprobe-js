/**
 * Task 7.3.1: loadNdjson(path, traceId?) streaming — loads all when traceId undefined.
 * Task 7.3.2: Filter by traceId — only matching traceId lines returned.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import type { SoftprobeCassetteRecord } from '../types/schema';
import { loadNdjson } from '../store/load-ndjson';

describe('loadNdjson', () => {
  it('loads all records when traceId is undefined', async () => {
    const tmpPath = path.join(os.tmpdir(), `softprobe-loadNdjson-${Date.now()}.ndjson`);
    const line1 = '{"version":"4.1","traceId":"t1","spanId":"s1","timestamp":"2025-01-01T00:00:00.000Z","type":"outbound","protocol":"postgres","identifier":"SELECT 1"}';
    const line2 = '{"version":"4.1","traceId":"t2","spanId":"s2","timestamp":"2025-01-01T00:00:01.000Z","type":"outbound","protocol":"redis","identifier":"GET k"}';
    fs.writeFileSync(tmpPath, line1 + '\n' + line2 + '\n', 'utf8');

    const records = await loadNdjson(tmpPath);

    expect(records).toHaveLength(2);
    expect((records[0] as SoftprobeCassetteRecord).spanId).toBe('s1');
    expect((records[0] as SoftprobeCassetteRecord).traceId).toBe('t1');
    expect((records[1] as SoftprobeCassetteRecord).spanId).toBe('s2');
    expect((records[1] as SoftprobeCassetteRecord).traceId).toBe('t2');

    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup
    }
  });

  it('returns only records matching traceId when traceId is provided', async () => {
    const tmpPath = path.join(os.tmpdir(), `softprobe-loadNdjson-traceId-${Date.now()}.ndjson`);
    const line1 = '{"version":"4.1","traceId":"t1","spanId":"s1","timestamp":"2025-01-01T00:00:00.000Z","type":"outbound","protocol":"postgres","identifier":"SELECT 1"}';
    const line2 = '{"version":"4.1","traceId":"t2","spanId":"s2","timestamp":"2025-01-01T00:00:01.000Z","type":"outbound","protocol":"redis","identifier":"GET k"}';
    const line3 = '{"version":"4.1","traceId":"t1","spanId":"s3","timestamp":"2025-01-01T00:00:02.000Z","type":"outbound","protocol":"http","identifier":"GET /"}';
    fs.writeFileSync(tmpPath, line1 + '\n' + line2 + '\n' + line3 + '\n', 'utf8');

    const records = await loadNdjson(tmpPath, 't1');

    expect(records).toHaveLength(2);
    expect(records.every((r) => r.traceId === 't1')).toBe(true);
    expect(records.map((r) => r.spanId).sort()).toEqual(['s1', 's3']);

    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup
    }
  });
});
