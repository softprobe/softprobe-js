/**
 * Auto-instrumentation mutator: wraps getNodeAutoInstrumentations to inject
 * Softprobe responseHook for Postgres, HTTP/Undici (and other protocols as needed)
 * so that capture mode records request/response payloads on spans.
 */

import shimmer from 'shimmer';

const PG_INSTRUMENTATION_NAME = '@opentelemetry/instrumentation-pg';
const UNDICI_INSTRUMENTATION_NAME = '@opentelemetry/instrumentation-undici';

/** Module-like object that exposes getNodeAutoInstrumentations (for real use or tests). */
export interface AutoInstrumentationsModule {
  getNodeAutoInstrumentations: (options?: unknown) => unknown[];
}

/**
 * Builds the responseHook to attach to the Postgres instrumentation.
 * In capture mode this runs after each query and records request/response on the span.
 */
function buildPostgresResponseHook(): (span: unknown, result: unknown) => void {
  return (_span: unknown, _result: unknown) => {
    // Placeholder: full capture logic (setting softprobe.* attributes) can be added later.
  };
}

/**
 * Injects our custom responseHook into the @opentelemetry/instrumentation-pg
 * entry in the array returned by getNodeAutoInstrumentations.
 */
function injectPostgresResponseHook(result: unknown[]): unknown[] {
  for (const item of result) {
    const entry = item as { instrumentationName?: string; responseHook?: unknown };
    if (entry.instrumentationName === PG_INSTRUMENTATION_NAME) {
      entry.responseHook = buildPostgresResponseHook();
      break;
    }
  }
  return result;
}

/** Request-like shape from undici instrumentation (method, url or origin+path). */
interface UndiciRequestLike {
  method?: string;
  url?: string;
  origin?: string;
  path?: string;
}

/** Result-like shape passed to undici responseHook (span, result). */
interface UndiciResultLike {
  request?: UndiciRequestLike;
  response?: { statusCode?: number; body?: unknown };
}

/**
 * Builds the responseHook for HTTP/Undici instrumentation.
 * Sets softprobe.protocol, softprobe.identifier (method + URL), and optional
 * request/response body on the span per design §3.1.
 */
function buildHttpUndiciResponseHook(): (
  span: { setAttribute: (key: string, value: unknown) => void },
  result: UndiciResultLike
) => void {
  return (span, result) => {
    const req = result?.request;
    const method = (req?.method ?? 'GET').toUpperCase();
    const url =
      req?.url ??
      (req?.origin && req?.path
        ? `${req.origin}${req.path.startsWith('/') ? '' : '/'}${req.path}`
        : '');
    const identifier = `${method} ${url}`.trim() || 'GET';

    span.setAttribute('softprobe.protocol', 'http');
    span.setAttribute('softprobe.identifier', identifier);
    if (req && typeof (req as any).body !== 'undefined') {
      span.setAttribute(
        'softprobe.request.body',
        JSON.stringify((req as any).body)
      );
    }
    if (result?.response != null) {
      const payload: { statusCode?: number; body?: unknown } = {
        statusCode: result.response.statusCode,
      };
      if (typeof (result.response as any).body !== 'undefined') {
        payload.body = (result.response as any).body;
      }
      span.setAttribute('softprobe.response.body', JSON.stringify(payload));
    }
  };
}

/**
 * Injects our custom responseHook into the @opentelemetry/instrumentation-undici
 * entry in the array returned by getNodeAutoInstrumentations.
 */
function injectHttpUndiciResponseHook(result: unknown[]): unknown[] {
  for (const item of result) {
    const entry = item as { instrumentationName?: string; responseHook?: unknown };
    if (entry.instrumentationName === UNDICI_INSTRUMENTATION_NAME) {
      entry.responseHook = buildHttpUndiciResponseHook();
      break;
    }
  }
  return result;
}

/**
 * Wraps getNodeAutoInstrumentations so that the returned config includes our
 * custom responseHook for Postgres. Pass a module object to mutate (e.g. for tests);
 * if omitted, the real @opentelemetry/auto-instrumentations-node module is used.
 */
export function applyAutoInstrumentationMutator(
  target?: AutoInstrumentationsModule
): void {
  const moduleExport =
    target ?? require('@opentelemetry/auto-instrumentations-node');

  shimmer.wrap(
    moduleExport,
    'getNodeAutoInstrumentations',
    ((original: (options?: unknown) => unknown[]) => {
      return function wrappedGetNodeAutoInstrumentations(
        this: AutoInstrumentationsModule,
        options?: unknown
      ) {
        const result = original.call(this, options);
        const arr = Array.isArray(result) ? result : [];
        injectPostgresResponseHook(arr);
        return injectHttpUndiciResponseHook(arr);
      };
    }) as (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown
  );
}
