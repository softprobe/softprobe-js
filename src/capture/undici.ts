/**
 * Capture hook for HTTP/Undici. Pairs with replay/undici.ts (same protocol & identifier).
 * Design §3.1, §5.3: responseHook contract must match @opentelemetry/instrumentation-undici.
 * Design §10.3: when capture store is set, writes outbound record (identifier = METHOD url).
 *
 * Response body: @opentelemetry/instrumentation-undici calls responseHook from onResponseHeaders
 * (when response headers are received). Its UndiciResponse type has only headers, statusCode,
 * statusText — no body. The comment in the instrumentation says "body may not be accessible yet".
 * So we never receive the response body here; responsePayload.body will be undefined. To capture
 * the body we need another path (e.g. a fetch wrapper in CAPTURE that reads the body).
 */

import type { SoftprobeCassetteRecord } from '../types/schema';
import { getCaptureStore, captureUsesInterceptor } from './store-accessor';

/** Request-like shape from undici instrumentation (method, url or origin+path). Contract: align with real package. */
export interface UndiciRequestLike {
  method?: string;
  url?: string;
  origin?: string;
  path?: string;
  body?: unknown;
}

/**
 * Result shape passed to undici responseHook(span, result).
 * The real UndiciResponse (see instrumentation-undici types) has only headers, statusCode, statusText — no body.
 * We allow response.body in the type so we can use it if a future version or fork provides it.
 */
export interface UndiciResultLike {
  request?: UndiciRequestLike;
  response?: { statusCode?: number; statusText?: string; body?: unknown };
}

export const UNDICI_INSTRUMENTATION_NAME = '@opentelemetry/instrumentation-undici';

/** Span-like shape for responseHook (context + optional attributes). */
interface SpanLike {
  spanContext?: () => { traceId: string; spanId: string };
  parentSpanId?: string;
  name?: string;
  setAttribute?: (key: string, value: unknown) => void;
}

/**
 * Builds the responseHook for HTTP/Undici instrumentation.
 * Sets softprobe.protocol, softprobe.identifier (method + URL), and optional
 * request/response body on the span per design §3.1.
 * When a capture store is set, writes an outbound SoftprobeCassetteRecord (Task 10.3.1).
 * Signature (span: unknown, result: unknown) for compatibility with injectResponseHook.
 */
export function buildUndiciResponseHook(): (span: unknown, result: unknown) => void {
  return (span, result) => {
    const s = span as SpanLike & { setAttribute: (key: string, value: unknown) => void };
    const res = result as UndiciResultLike;
    const req = res?.request;
    const method = (req?.method ?? 'GET').toUpperCase();
    const url =
      req?.url ??
      (req?.origin && req?.path
        ? `${req.origin}${req.path.startsWith('/') ? '' : '/'}${req.path}`
        : '');
    const identifier = `${method} ${url}`.trim() || 'GET';

    s.setAttribute?.('softprobe.protocol', 'http');
    s.setAttribute?.('softprobe.identifier', identifier);
    if (req && typeof req.body !== 'undefined') {
      s.setAttribute?.('softprobe.request.body', JSON.stringify(req.body));
    }
    if (res?.response != null) {
      const payload: { statusCode?: number; body?: unknown } = {
        statusCode: res.response.statusCode,
      };
      if (typeof (res.response as { body?: unknown }).body !== 'undefined') {
        payload.body = (res.response as { body?: unknown }).body;
      }
      s.setAttribute?.('softprobe.response.body', JSON.stringify(payload));
    }

    if (captureUsesInterceptor()) return;

    const store = getCaptureStore();
    if (!store) return;

    const ctx = s.spanContext?.() ?? { traceId: '', spanId: '' };
    const requestPayload =
      req && typeof req.body !== 'undefined' ? { body: req.body } : undefined;
    const responsePayload =
      res?.response != null
        ? {
            statusCode: res.response.statusCode,
            body: (res.response as { body?: unknown }).body,
          }
        : undefined;
    const record: SoftprobeCassetteRecord = {
      version: '4.1',
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      parentSpanId: s.parentSpanId,
      spanName: s.name,
      timestamp: new Date().toISOString(),
      type: 'outbound',
      protocol: 'http',
      identifier,
      requestPayload,
      responsePayload,
    };
    store.saveRecord(record);
  };
}
