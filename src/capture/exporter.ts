import fs from 'fs';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';

export interface SoftprobeTraceExporterOptions {
  /** Output path for softprobe-traces.json. Defaults to ./softprobe-traces.json */
  filePath?: string;
}

/** Serialized span shape written to disk (no circular refs). */
interface SerializedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name?: string;
  attributes: Record<string, unknown>;
}

/**
 * SpanExporter that appends ReadableSpans to a JSON file keyed by traceId.
 * Used in capture mode to persist full trace topology for replay.
 * Not safe for concurrent export from multiple processes (read-modify-write).
 * Only JSON-serializable attribute values are supported for correct round-trip.
 */
export class SoftprobeTraceExporter implements SpanExporter {
  private readonly filePath: string;

  constructor(options: SoftprobeTraceExporterOptions = {}) {
    this.filePath = options.filePath ?? './softprobe-traces.json';
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      let store: Record<string, SerializedSpan[]> = {};
      if (fs.existsSync(this.filePath)) {
        store = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      }

      for (const span of spans) {
        const traceId = span.spanContext().traceId;
        if (!store[traceId]) store[traceId] = [];
        store[traceId].push(this.serializeSpan(span));
      }

      fs.writeFileSync(this.filePath, JSON.stringify(store, null, 2));
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (err) {
      resultCallback({ code: ExportResultCode.FAILED, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  /** Maps ReadableSpan to a plain object (avoids circular references). */
  private serializeSpan(span: ReadableSpan): SerializedSpan {
    const ctx = span.spanContext();
    return {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      attributes: (span.attributes ?? {}) as Record<string, unknown>,
    };
  }
}
