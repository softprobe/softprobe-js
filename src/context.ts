/**
 * Single immutable context API for Softprobe (design-context.md).
 * One module: read via SoftprobeContext getters, write via withData/initGlobal/fromHeaders/run.
 */

import { randomBytes } from 'crypto';
import { createContextKey, context } from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';
import type { Cassette, SoftprobeCassetteRecord, SoftprobeRunOptions } from './types/schema';
import type { SemanticMatcher } from './replay/matcher';
import { SoftprobeMatcher } from './replay/softprobe-matcher';
import { createDefaultMatcher } from './replay/extract-key';

/** Context key under which softprobe state is stored in OTel Context. Exported for tests. */
export const SOFTPROBE_CONTEXT_KEY = createContextKey('softprobe_context');

/** Internal stored shape (not exported). */
interface Stored {
  mode: 'CAPTURE' | 'REPLAY' | 'PASSTHROUGH';
  storage?: Cassette;
  traceId?: string;
  strictReplay?: boolean;
  strictComparison?: boolean;
  matcher?: SemanticMatcher | SoftprobeMatcher;
  inboundRecord?: SoftprobeCassetteRecord;
}

/** Partial context for run() and withData(); all fields optional. */
interface PartialData {
  mode?: 'CAPTURE' | 'REPLAY' | 'PASSTHROUGH';
  storage?: Cassette;
  traceId?: string;
  strictReplay?: boolean;
  strictComparison?: boolean;
  matcher?: SemanticMatcher | SoftprobeMatcher | unknown;
  inboundRecord?: SoftprobeCassetteRecord;
}

let globalDefault: Stored = {
  mode: 'PASSTHROUGH',
  strictReplay: false,
  strictComparison: false,
};

let globalReplayMatcher: SoftprobeMatcher | undefined;

function merge(base: Stored, partial: PartialData): Stored {
  return {
    ...base,
    ...(partial.mode !== undefined && { mode: partial.mode }),
    ...(partial.storage !== undefined && { storage: partial.storage }),
    ...(partial.traceId !== undefined && { traceId: partial.traceId }),
    ...(partial.strictReplay !== undefined && { strictReplay: partial.strictReplay }),
    ...(partial.strictComparison !== undefined && { strictComparison: partial.strictComparison }),
    ...(partial.matcher !== undefined && { matcher: partial.matcher as Stored['matcher'] }),
    ...(partial.inboundRecord !== undefined && { inboundRecord: partial.inboundRecord }),
  };
}

/**
 * Returns the current softprobe state from the given OTel context, or global default when empty.
 * When otelContext is omitted, uses context.active().
 */
function active(otelContext: Context = context.active()): Stored {
  const value = otelContext.getValue(SOFTPROBE_CONTEXT_KEY) as Stored | undefined;
  return value ?? globalDefault;
}

/**
 * Returns a new OTel context with the given softprobe data. Does not mutate otelContext.
 */
function withData(otelContext: Context, data: PartialData): Context {
  const stored = merge(globalDefault, data);
  return otelContext.setValue(SOFTPROBE_CONTEXT_KEY, stored);
}

/**
 * Seeds the global default from config. Call at boot.
 */
function initGlobal(config: {
  mode?: string;
  cassettePath?: string;
  storage?: Cassette;
  strictReplay?: boolean;
  strictComparison?: boolean;
}): void {
  globalDefault = {
    mode: (config.mode as Stored['mode']) || 'PASSTHROUGH',
    ...(config.storage !== undefined && { storage: config.storage }),
    strictReplay: config.strictReplay ?? false,
    strictComparison: config.strictComparison ?? false,
  };
}

const HEADER_MODE = 'x-softprobe-mode';
const HEADER_TRACE_ID = 'x-softprobe-trace-id';

function readHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  key: string
): string | undefined {
  const value = headers[key];
  if (typeof value === 'string' && value) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0]) return value[0];
  return undefined;
}

/**
 * Returns a new softprobe state by applying coordination headers over base. Used by middleware.
 */
function fromHeaders(
  base: Stored,
  headers: Record<string, string | string[] | undefined>
): Stored {
  const mode = readHeaderValue(headers, HEADER_MODE);
  const traceId = readHeaderValue(headers, HEADER_TRACE_ID);
  return {
    ...base,
    ...(mode && (mode === 'REPLAY' || mode === 'CAPTURE' || mode === 'PASSTHROUGH') && { mode: mode as Stored['mode'] }),
    ...(traceId && { traceId }),
  };
}

/**
 * Sets the global matcher used when active context has no matcher (e.g. server REPLAY mode).
 */
function setGlobalReplayMatcher(matcher: SoftprobeMatcher | undefined): void {
  globalReplayMatcher = matcher;
}

function getTraceId(otelContext?: Context): string {
  return active(otelContext).traceId ?? '';
}

function getMode(otelContext?: Context): 'CAPTURE' | 'REPLAY' | 'PASSTHROUGH' {
  return active(otelContext).mode;
}

function getCassette(otelContext?: Context): Cassette | undefined {
  return active(otelContext).storage;
}

function getScopedCassette(otelContext: Context = context.active()): Cassette | undefined {
  const value = otelContext.getValue(SOFTPROBE_CONTEXT_KEY) as Stored | undefined;
  return value?.storage;
}

function getStrictReplay(otelContext?: Context): boolean {
  return active(otelContext).strictReplay ?? false;
}

function getStrictComparison(otelContext?: Context): boolean {
  return active(otelContext).strictComparison ?? false;
}

/** Returns the matcher from active context only. */
function getMatcher(otelContext?: Context): SemanticMatcher | SoftprobeMatcher | undefined {
  const ctx = otelContext ?? context.active();
  const stored = active(ctx);
  return stored.matcher;
}

function getInboundRecord(otelContext?: Context): SoftprobeCassetteRecord | undefined {
  return active(otelContext).inboundRecord;
}

/** Runs fn inside an OTel scope seeded from required Softprobe run options. */
function ensureTraceId(stored: Stored, fallback: string): Stored {
  return stored.traceId ? stored : { ...stored, traceId: fallback };
}

function run<T>(options: SoftprobeRunOptions, fn: () => T | Promise<T>): T | Promise<T> {
  const base = active(context.active());
  const mergedBase = merge(base, options);
  const defaultTraceId = (): string => randomBytes(16).toString('hex');

  if (options.mode === 'REPLAY') {
    const traceId = options.traceId || mergedBase.traceId || base.traceId || defaultTraceId();
    return (async () => {
      const records = await options.storage.loadTrace(traceId);
      const matcher = new SoftprobeMatcher();
      matcher._setRecords(records);
      matcher.use(options.matcher ?? createDefaultMatcher());
      const withReplayData = merge(mergedBase, { matcher });
      const withTraceId = ensureTraceId(withReplayData, traceId);
      const ctxWith = withData(context.active(), withTraceId);
      return context.with(ctxWith, fn) as Promise<T>;
    })();
  }

  const withTraceId = ensureTraceId(mergedBase, mergedBase.traceId || base.traceId || defaultTraceId());
  const ctxWith = withData(context.active(), withTraceId);
  return context.with(ctxWith, fn) as T | Promise<T>;
}

export const SoftprobeContext = {
  active,
  getTraceId,
  getMode,
  getCassette,
  getScopedCassette,
  getStrictReplay,
  getStrictComparison,
  getMatcher,
  getInboundRecord,
  withData,
  initGlobal,
  fromHeaders,
  setGlobalReplayMatcher,
  run,
};
