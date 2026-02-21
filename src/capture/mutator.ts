/**
 * Auto-instrumentation mutator: wraps getNodeAutoInstrumentations to inject
 * Softprobe responseHook for Postgres (and other protocols as needed) so that
 * capture mode records request/response payloads on spans.
 */

import shimmer from 'shimmer';

const PG_INSTRUMENTATION_NAME = '@opentelemetry/instrumentation-pg';

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
        return injectPostgresResponseHook(arr);
      };
    }) as (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown
  );
}
