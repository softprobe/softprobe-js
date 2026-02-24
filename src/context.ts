/**
 * Unified OTel context for Softprobe (mode, cassettePath, traceId, etc.).
 * Task 17.2.1: key for storing softprobe state in OTel Context.
 * Task 17.2.2: setSoftprobeContext(ctx, value) returns a new context with the value.
 * Task 17.2.3: getSoftprobeContext(ctx?) with global fallback seeded from YAML.
 */

import { createContextKey, Context, context } from '@opentelemetry/api';

/** Context key under which Softprobe state is stored in OTel Context. */
export const SOFTPROBE_CONTEXT_KEY = createContextKey('softprobe_context');

/** Value stored under SOFTPROBE_CONTEXT_KEY (design §3). Task 18.1.2: optional matcher so query() uses context first. */
export interface SoftprobeContextValue {
  mode: 'CAPTURE' | 'REPLAY' | 'PASSTHROUGH';
  cassettePath: string;
  traceId?: string;
  /** When true, CONTINUE (no match) throws instead of passthrough (replay shims). */
  strictReplay?: boolean;
  /** When true, compareInbound also compares headers. */
  strictComparison?: boolean;
  /** Optional matcher; when set, getActiveMatcher() returns it first (Task 18.1.2). */
  matcher?: unknown;
}

/** Global default seeded from config at boot (design §4). Safe default until initGlobalContext is called. */
let globalDefault: SoftprobeContextValue = {
  mode: 'PASSTHROUGH',
  cassettePath: '',
  strictReplay: false,
  strictComparison: false,
};

/**
 * Seeds the global default from YAML config. Call at boot so getSoftprobeContext can fall back when context is empty.
 */
export function initGlobalContext(config: {
  mode?: string;
  cassettePath?: string;
  strictReplay?: boolean;
  strictComparison?: boolean;
}): void {
  globalDefault = {
    mode: (config.mode as SoftprobeContextValue['mode']) || 'PASSTHROUGH',
    cassettePath: config.cassettePath ?? '',
    strictReplay: config.strictReplay ?? false,
    strictComparison: config.strictComparison ?? false,
  };
}

/**
 * Returns the Softprobe value from the given context, or globalDefault when context has no value (bootstrap case).
 * When ctx is omitted, uses the active OTel context.
 */
export function getSoftprobeContext(ctx: Context = context.active()): SoftprobeContextValue {
  const activeValue = ctx.getValue(SOFTPROBE_CONTEXT_KEY) as SoftprobeContextValue | undefined;
  return activeValue ?? globalDefault;
}

/**
 * Sets the Softprobe context value on the given OTel Context. Returns a new context (immutable).
 */
export function setSoftprobeContext(ctx: Context, value: SoftprobeContextValue): Context {
  return ctx.setValue(SOFTPROBE_CONTEXT_KEY, value);
}

/** Coordination header names (design §2.1: CLI injects these for dynamic replay). */
const HEADER_MODE = 'x-softprobe-mode';
const HEADER_TRACE_ID = 'x-softprobe-trace-id';
const HEADER_CASSETTE_PATH = 'x-softprobe-cassette-path';

/**
 * Overrides from coordination headers when present. Design §3.2: middleware prioritizes headers over global YAML.
 * Header keys are case-insensitive; pass raw headers object (Express/Fastify use lowercase keys).
 */
export function softprobeValueFromHeaders(
  base: SoftprobeContextValue,
  headers: Record<string, string | string[] | undefined>
): SoftprobeContextValue {
  const mode = headers[HEADER_MODE];
  const traceId = headers[HEADER_TRACE_ID];
  const cassettePath = headers[HEADER_CASSETTE_PATH];
  return {
    ...base,
    ...(typeof mode === 'string' && (mode === 'REPLAY' || mode === 'CAPTURE' || mode === 'PASSTHROUGH') && { mode: mode as SoftprobeContextValue['mode'] }),
    ...(typeof traceId === 'string' && traceId && { traceId }),
    ...(typeof cassettePath === 'string' && cassettePath && { cassettePath }),
  };
}
