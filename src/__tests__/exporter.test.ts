import fs from 'fs';
import path from 'path';
import os from 'os';
import { SoftprobeTraceExporter } from '../capture/exporter';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';

function mockSpan(traceId: string, spanId: string, name: string, attrs: Record<string, unknown>): ReadableSpan {
  return {
    name,
    parentSpanId: 'parent-1',
    spanContext: () => ({ traceId, spanId } as ReturnType<ReadableSpan['spanContext']>),
    attributes: attrs,
  } as unknown as ReadableSpan;
}

describe('SoftprobeTraceExporter', () => {
  let testFilePath: string;

  beforeEach(() => {
    testFilePath = path.join(os.tmpdir(), `softprobe-exporter-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });

  afterEach(() => {
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
  });

  it('creates JSON file and writes serialized spans on export', (done) => {
    const span = mockSpan('trace-abc', 'span-1', 'pg.query', {
      'softprobe.protocol': 'postgres',
      'softprobe.identifier': 'SELECT 1',
      'softprobe.response.body': '[{"id":1}]',
    });

    const exporter = new SoftprobeTraceExporter({ filePath: testFilePath });
    exporter.export([span], (result: ExportResult) => {
      expect(result.code).toBe(ExportResultCode.SUCCESS);
      expect(fs.existsSync(testFilePath)).toBe(true);
      const content = JSON.parse(fs.readFileSync(testFilePath, 'utf-8'));
      expect(content['trace-abc']).toBeDefined();
      expect(Array.isArray(content['trace-abc'])).toBe(true);
      expect(content['trace-abc']).toHaveLength(1);
      const serialized = content['trace-abc'][0];
      expect(serialized.traceId).toBe('trace-abc');
      expect(serialized.spanId).toBe('span-1');
      expect(serialized.name).toBe('pg.query');
      expect(serialized.parentSpanId).toBe('parent-1');
      expect(serialized.attributes['softprobe.protocol']).toBe('postgres');
      expect(serialized.attributes['softprobe.identifier']).toBe('SELECT 1');
      expect(serialized.attributes['softprobe.response.body']).toBe('[{"id":1}]');
      done();
    });
  });

  it('merges new spans into existing file (same traceId and different traceId)', (done) => {
    const span1 = mockSpan('trace-1', 'span-1', 'a', { 'softprobe.protocol': 'http' });
    const span2 = mockSpan('trace-1', 'span-2', 'b', { 'softprobe.protocol': 'http' });
    const span3 = mockSpan('trace-2', 'span-3', 'c', { 'softprobe.protocol': 'postgres' });

    const exporter = new SoftprobeTraceExporter({ filePath: testFilePath });

    exporter.export([span1], (result1) => {
      expect(result1.code).toBe(ExportResultCode.SUCCESS);
      exporter.export([span2, span3], (result2) => {
        expect(result2.code).toBe(ExportResultCode.SUCCESS);
        const content = JSON.parse(fs.readFileSync(testFilePath, 'utf-8'));
        expect(content['trace-1']).toHaveLength(2);
        expect(content['trace-2']).toHaveLength(1);
        expect(content['trace-1'][0].spanId).toBe('span-1');
        expect(content['trace-1'][1].spanId).toBe('span-2');
        expect(content['trace-2'][0].spanId).toBe('span-3');
        done();
      });
    });
  });
});
