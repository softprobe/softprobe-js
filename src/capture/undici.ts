/**
 * Capture hook for HTTP/Undici. Pairs with replay/undici.ts (same protocol & identifier).
 * Design §3.1, §5.3: responseHook contract must match @opentelemetry/instrumentation-undici.
 */

/** Request-like shape from undici instrumentation (method, url or origin+path). Contract: align with real package. */
export interface UndiciRequestLike {
  method?: string;
  url?: string;
  origin?: string;
  path?: string;
  body?: unknown;
}

/** Result shape passed to undici responseHook(span, result). Contract: align with real package. */
export interface UndiciResultLike {
  request?: UndiciRequestLike;
  response?: { statusCode?: number; body?: unknown };
}

export const UNDICI_INSTRUMENTATION_NAME = '@opentelemetry/instrumentation-undici';

/**
 * Builds the responseHook for HTTP/Undici instrumentation.
 * Sets softprobe.protocol, softprobe.identifier (method + URL), and optional
 * request/response body on the span per design §3.1.
 * Signature (span: unknown, result: unknown) for compatibility with injectResponseHook.
 */
export function buildUndiciResponseHook(): (span: unknown, result: unknown) => void {
  return (span, result) => {
    const s = span as { setAttribute: (key: string, value: unknown) => void };
    const res = result as UndiciResultLike;
    const req = res?.request;
    const method = (req?.method ?? 'GET').toUpperCase();
    const url =
      req?.url ??
      (req?.origin && req?.path
        ? `${req.origin}${req.path.startsWith('/') ? '' : '/'}${req.path}`
        : '');
    const identifier = `${method} ${url}`.trim() || 'GET';

    s.setAttribute('softprobe.protocol', 'http');
    s.setAttribute('softprobe.identifier', identifier);
    if (req && typeof req.body !== 'undefined') {
      s.setAttribute('softprobe.request.body', JSON.stringify(req.body));
    }
    if (res?.response != null) {
      const payload: { statusCode?: number; body?: unknown } = {
        statusCode: res.response.statusCode,
      };
      if (typeof (res.response as { body?: unknown }).body !== 'undefined') {
        payload.body = (res.response as { body?: unknown }).body;
      }
      s.setAttribute('softprobe.response.body', JSON.stringify(payload));
    }
  };
}
