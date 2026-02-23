/**
 * Capture hooks for Postgres. Pairs with replay/postgres.ts (same protocol & identifier).
 * Design §3.1, §5.3: hooks align with @opentelemetry/instrumentation-pg contracts.
 * Design §10.4: query result rows written to NDJSON outbound record via CassetteStore.
 *
 * Unlike Redis/undici where a single responseHook receives both request and response
 * info, instrumentation-pg splits them into separate hooks:
 *   requestHook(span, { query: { text, values?, name? }, connection })
 *   responseHook(span, { data: { rows, rowCount, command, ... } })
 */

import type { SoftprobeCassetteRecord } from '../types/schema';
import { getCaptureStore } from './store-accessor';

/** Query info passed to the pg requestHook. Contract: PgRequestHookInformation. */
export interface PgQueryInfo {
  query: { text: string; name?: string; values?: unknown[] };
  connection?: { database?: string; host?: string; port?: number; user?: string };
}

/** Result info passed to the pg responseHook. Contract: PgResponseHookInformation. */
export interface PgResultInfo {
  data: { rows?: unknown[]; rowCount?: number | null; command?: string };
}

export const PG_INSTRUMENTATION_NAME = '@opentelemetry/instrumentation-pg';

/** Span-like shape used by responseHook (context + attributes from requestHook). */
interface SpanLike {
  spanContext?: () => { traceId: string; spanId: string };
  parentSpanId?: string;
  name?: string;
  attributes?: Record<string, unknown>;
  setAttribute?: (key: string, value: unknown) => void;
}

/**
 * Builds the requestHook for Postgres instrumentation.
 * Sets softprobe.protocol, softprobe.identifier (SQL text), and softprobe.request.body
 * (query text + values) on the span.
 */
export function buildPostgresRequestHook(): (span: unknown, queryInfo: unknown) => void {
  return (span, queryInfo) => {
    const s = span as { setAttribute: (key: string, value: unknown) => void };
    const info = queryInfo as PgQueryInfo;
    const text = info?.query?.text ?? '';

    s.setAttribute('softprobe.protocol', 'postgres');
    s.setAttribute('softprobe.identifier', text);
    s.setAttribute(
      'softprobe.request.body',
      JSON.stringify({ text, values: info?.query?.values ?? [] }),
    );
  };
}

/**
 * Builds the responseHook for Postgres instrumentation.
 * Sets softprobe.response.body on the span and, when a capture store is set,
 * writes an outbound SoftprobeCassetteRecord with responsePayload.rows (Task 10.4.1).
 */
export function buildPostgresResponseHook(): (span: unknown, result: unknown) => void {
  return (span, result) => {
    const s = span as SpanLike & { setAttribute: (key: string, value: unknown) => void };
    const info = result as PgResultInfo;
    const data = info?.data ?? {};
    const responseBody = { rows: data.rows ?? [], rowCount: data.rowCount ?? 0, command: data.command };
    if (s.setAttribute) {
      s.setAttribute('softprobe.response.body', JSON.stringify(responseBody));
    }

    const store = getCaptureStore();
    if (!store) return;

    const ctx = s.spanContext?.() ?? { traceId: '', spanId: '' };
    const attrs = s.attributes ?? {};
    const record: SoftprobeCassetteRecord = {
      version: '4.1',
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      parentSpanId: s.parentSpanId,
      spanName: s.name,
      timestamp: new Date().toISOString(),
      type: 'outbound',
      protocol: 'postgres',
      identifier: (attrs['softprobe.identifier'] as string) ?? '',
      responsePayload: { rows: data.rows ?? [], rowCount: data.rowCount ?? 0, command: data.command },
    };
    store.saveRecord(record);
  };
}
