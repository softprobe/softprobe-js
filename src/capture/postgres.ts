/**
 * Capture hook for Postgres. Pairs with replay/postgres.ts (same protocol & identifier).
 * Design §3.1, §5.3: responseHook contract must match @opentelemetry/instrumentation-pg.
 */

export const PG_INSTRUMENTATION_NAME = '@opentelemetry/instrumentation-pg';

/**
 * Builds the responseHook to attach to the Postgres instrumentation.
 * In capture mode this runs after each query and records request/response on the span.
 * Contract: when instrumentation-pg calls responseHook(span, result), result shape
 * should be aligned with the package's types; currently a placeholder until contract is verified.
 */
export function buildPostgresResponseHook(): (span: unknown, result: unknown) => void {
  return (_span: unknown, _result: unknown) => {
    // Placeholder: full capture logic (setting softprobe.* attributes) when pg contract is verified.
  };
}
