/**
 * HTTP/Undici replay: intercepts fetch so that under replay context requests
 * are resolved by the active matcher (no live network). Pairs with capture
 * Task 4.4; identifier = method + URL per design §3.1, §6.2.
 * Uses SoftprobeMatcher.match(spanOverride) so replay returns the exact recorded
 * response (Node 18+ global fetch uses undici; MSW FetchInterceptor can bypass).
 * When an inbound record exists for the trace, we return its "http" section as
 * the fetch body so the app response matches the recorded inbound (same Traceparent etc).
 */

import shimmer from 'shimmer';
import { trace } from '@opentelemetry/api';
import { softprobe } from '../api';
import { SoftprobeContext } from '../context';

/** responsePayload shape from cassette outbound HTTP record. */
interface RecordedHttpPayload {
  statusCode?: number;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function strictNoMatchResponse(): Response {
  return new Response(
    JSON.stringify({ error: '[Softprobe] No recorded traces found for http request' }),
    { status: 500, headers: { 'content-type': 'application/json' } }
  );
}

function toTextBody(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body == null) return '{}';
  return JSON.stringify(body);
}

/** Parses inbound responsePayload.body and returns the .http field if present (so mock matches recorded response). */
function getInboundHttpBody(traceId: string | undefined): unknown {
  if (!traceId) return undefined;
  const records = softprobe.getRecordsForTrace(traceId);
  const inbound = records.find((r) => r.type === 'inbound');
  const payload = inbound?.responsePayload as { body?: unknown } | undefined;
  const body = payload?.body;
  if (body == null) return undefined;
  const parsed = typeof body === 'string' ? (() => { try { return JSON.parse(body); } catch { return undefined; } })() : body;
  return parsed && typeof parsed === 'object' && 'http' in parsed ? (parsed as { http: unknown }).http : undefined;
}

/**
 * Sets up HTTP/Undici replay by wrapping undici fetch. When replay context
 * has a matcher and it returns MOCK, returns the recorded status and body.
 * Prefers the inbound record's "http" section when present so diff matches exactly.
 */
export function setupUndiciReplay(): void {
  const undici = require('undici') as { fetch: typeof fetch };
  shimmer.wrap(undici, 'fetch', (originalFetch: (...args: unknown[]) => unknown) => {
    const original = originalFetch as typeof fetch;
    return function wrappedFetch(...args: unknown[]): unknown {
      const input = args[0] as string | URL | Request;
      const init = args[1] as RequestInit | undefined;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const identifier = `${method} ${url}`;

      const matcher = softprobe.getActiveMatcher() as { match?: (spanOverride?: { attributes?: Record<string, unknown> }) => { action: string; payload?: unknown }; _getTraceId?: () => string | undefined } | undefined;
      if (!matcher?.match) return original(input, init);

      const spanOverride = { attributes: { 'softprobe.protocol': 'http' as const, 'softprobe.identifier': identifier } };
      const result = matcher.match(spanOverride);

      if (result.action === 'MOCK' && result.payload != null) {
        // Prefer inbound .http from matcher's records (set for this request); fallback to global store by traceId.
        const matcherWithInbound = matcher as {
          match?: (spanOverride?: { attributes?: Record<string, unknown> }) => { action: string; payload?: unknown };
          _getTraceId?: () => string | undefined;
          _getInboundHttpBody?: () => unknown;
        };
        const inboundHttp =
          matcherWithInbound._getInboundHttpBody?.() ??
          getInboundHttpBody(
            (result as { traceId?: string }).traceId ??
              SoftprobeContext.getTraceId() ??
              trace.getActiveSpan()?.spanContext()?.traceId ??
              matcherWithInbound._getTraceId?.()
          );
        const payload = result.payload as RecordedHttpPayload;
        const status = payload.status ?? payload.statusCode ?? 200;
        const body = inboundHttp !== undefined ? inboundHttp : payload.body;
        const bodyStr = toTextBody(body);
        return Promise.resolve(
          new Response(bodyStr, { status, headers: payload.headers })
        );
      }

      if (SoftprobeContext.getStrictReplay()) {
        return Promise.resolve(strictNoMatchResponse());
      }

      return original(input, init);
    };
  });
  applyUndiciFetchAsGlobal();
}

/** Re-assigns global fetch to the wrapped undici fetch. Call from REPLAY after instrumentation so our replay stays on top. */
export function applyUndiciFetchAsGlobal(): void {
  try {
    const undici = require('undici') as { fetch: typeof fetch };
    if (typeof undici.fetch === 'function' && typeof globalThis.fetch !== 'undefined') {
      globalThis.fetch = undici.fetch as typeof fetch;
    }
  } catch {
    // undici not available
  }
}
