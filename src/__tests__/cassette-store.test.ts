/**
 * Task 7.1.1: CassetteStore enqueue(line) FIFO and flush writes in order.
 * Task 7.1.2: saveRecord(record) serializes JSON + newline.
 * Task 7.2.1: maxQueueSize drops and counts drops.
 * Task 7.2.2: Best-effort flush on exit signals (test calls handler directly).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import type { SoftprobeCassetteRecord } from '../types/schema';
import { CassetteStore } from '../store/cassette-store';

describe('CassetteStore', () => {
  it('enqueue 3 lines, flush writes 3 in order', () => {
    const tmpPath = path.join(os.tmpdir(), `softprobe-cassette-${Date.now()}.ndjson`);
    const store = new CassetteStore(tmpPath);

    store.enqueue('{"version":"4.1","traceId":"t1","spanId":"s1"');
    store.enqueue('{"version":"4.1","traceId":"t1","spanId":"s2"');
    store.enqueue('{"version":"4.1","traceId":"t1","spanId":"s3"');
    store.flush();

    const content = fs.readFileSync(tmpPath, 'utf8');
    const lines = content.split('\n').filter((s) => s.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"spanId":"s1"');
    expect(lines[1]).toContain('"spanId":"s2"');
    expect(lines[2]).toContain('"spanId":"s3"');

    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup
    }
  });

  it('saveRecord serializes record as one JSON line per record', () => {
    const tmpPath = path.join(os.tmpdir(), `softprobe-saveRecord-${Date.now()}.ndjson`);
    const store = new CassetteStore(tmpPath);

    const record1: SoftprobeCassetteRecord = {
      version: '4.1',
      traceId: 't1',
      spanId: 's1',
      timestamp: '2025-01-01T00:00:00.000Z',
      type: 'outbound',
      protocol: 'postgres',
      identifier: 'SELECT 1',
    };
    const record2: SoftprobeCassetteRecord = {
      version: '4.1',
      traceId: 't1',
      spanId: 's2',
      timestamp: '2025-01-01T00:00:01.000Z',
      type: 'outbound',
      protocol: 'redis',
      identifier: 'GET k',
    };

    store.saveRecord(record1);
    store.saveRecord(record2);
    store.flush();

    const content = fs.readFileSync(tmpPath, 'utf8');
    const lines = content.split('\n').filter((s) => s.length > 0);
    expect(lines).toHaveLength(2);

    const parsed1 = JSON.parse(lines[0]) as SoftprobeCassetteRecord;
    expect(parsed1.version).toBe('4.1');
    expect(parsed1.spanId).toBe('s1');
    expect(parsed1.identifier).toBe('SELECT 1');

    const parsed2 = JSON.parse(lines[1]) as SoftprobeCassetteRecord;
    expect(parsed2.spanId).toBe('s2');
    expect(parsed2.identifier).toBe('GET k');

    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup
    }
  });

  it('maxQueueSize drops excess and dropCount reflects drops', () => {
    const tmpPath = path.join(os.tmpdir(), `softprobe-maxQueue-${Date.now()}.ndjson`);
    const store = new CassetteStore(tmpPath, { maxQueueSize: 2 });

    store.enqueue('a');
    store.enqueue('b');
    store.enqueue('c');
    store.enqueue('d');
    store.enqueue('e');

    expect(store.getDropCount()).toBe(3);
    store.flush();
    const content = fs.readFileSync(tmpPath, 'utf8');
    const lines = content.split('\n').filter((s) => s.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('a');
    expect(lines[1]).toBe('b');

    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup
    }
  });

  it('flushOnExit writes queued lines when called (same as SIGINT/SIGTERM handler)', () => {
    const tmpPath = path.join(os.tmpdir(), `softprobe-exitFlush-${Date.now()}.ndjson`);
    const store = new CassetteStore(tmpPath);

    store.enqueue('{"x":1}');
    store.enqueue('{"x":2}');
    store.flushOnExit();

    const content = fs.readFileSync(tmpPath, 'utf8');
    const lines = content.split('\n').filter((s) => s.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('{"x":1}');
    expect(lines[1]).toBe('{"x":2}');

    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup
    }
  });
});
