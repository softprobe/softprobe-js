import { AsyncLocalStorage } from 'async_hooks';
import type { SoftprobeCassetteRecord } from './types/schema';
import type { SemanticMatcher } from './replay/matcher';
import { SoftprobeMatcher } from './replay/softprobe-matcher';
import { createDefaultMatcher } from './replay/extract-key';
import { loadNdjson } from './store/load-ndjson';

/**
 * ALS store shape for replay context. traceId and cassettePath are used by
 * runWithContext; matcher is set when records are loaded (Task 8.2).
 * inboundRecord is set when loading a cassette that contains an inbound record (Task 8.2.2).
 */
export interface ReplayContext {
  traceId?: string;
  cassettePath?: string;
  /** Optional matcher for replay; when set, getActiveMatcher() returns it. */
  matcher?: SemanticMatcher | SoftprobeMatcher;
  /** Cached inbound record for this trace; used by getRecordedInboundResponse(). */
  inboundRecord?: SoftprobeCassetteRecord;
}

const replayStorage = new AsyncLocalStorage<ReplayContext | undefined>();

/**
 * Test-time API: run a function with the given replay context so that
 * concurrent tests (e.g. different workers) do not share matcher state.
 * When context.cassettePath is set, loads records once from NDJSON and sets
 * them on a SoftprobeMatcher before running the callback (Task 8.2.1).
 */
export function runWithContext<T>(
  context: ReplayContext,
  fn: () => T | Promise<T>
): T | Promise<T> {
  if (context.cassettePath) {
    const cassettePath = context.cassettePath;
    return (async () => {
      const records = await loadNdjson(cassettePath, context.traceId);
      const matcher = new SoftprobeMatcher();
      matcher._setRecords(records);
      matcher.use(createDefaultMatcher());
      const inboundRecord = records.find((r) => r.type === 'inbound');
      return replayStorage.run(
        { ...context, matcher, inboundRecord },
        fn
      ) as Promise<T>;
    })();
  }
  return replayStorage.run(context, fn) as T | Promise<T>;
}

/**
 * Returns the current replay context for the active async scope, or undefined if not in a replay context.
 */
export function getReplayContext(): ReplayContext | undefined {
  const store = replayStorage.getStore();
  return store === undefined ? undefined : store;
}

/**
 * Sets replay context for the current async context (e.g. in beforeEach).
 * For concurrent isolation, prefer runWithContext() so each flow has its own context.
 */
export function setReplayContext(context: ReplayContext): void {
  replayStorage.enterWith(context);
}

/**
 * Clears replay context for the current async context (e.g. in afterEach).
 */
export function clearReplayContext(): void {
  replayStorage.enterWith(undefined);
}

/**
 * Returns the active matcher (SemanticMatcher or SoftprobeMatcher) for the current
 * replay context, if any. In REPLAY mode without ALS context (e.g. server request), returns globalReplayMatcher.
 */
export function getActiveMatcher(): SemanticMatcher | SoftprobeMatcher | undefined {
  const ctx = getReplayContext();
  if (ctx?.matcher) return ctx.matcher;
  if (process.env.SOFTPROBE_MODE === 'REPLAY' && globalReplayMatcher) return globalReplayMatcher;
  return undefined;
}

/**
 * Returns the recorded inbound response for the current trace, if any.
 * Set by runWithContext when loading a cassette that contains a record with type "inbound".
 * Used by tests to compare live response to recorded (e.g. inbound?.responsePayload?.body).
 */
export function getRecordedInboundResponse(): SoftprobeCassetteRecord | undefined {
  const ctx = getReplayContext();
  return ctx?.inboundRecord;
}

/** Records loaded at REPLAY init (or set by tests). Used by getRecordsForTrace. */
let replayRecordsCache: SoftprobeCassetteRecord[] = [];

/**
 * Sets the global replay records cache (used by REPLAY init or tests).
 * Design §16.1: middleware primes matcher from records for the request traceId.
 */
export function setReplayRecordsCache(records: SoftprobeCassetteRecord[]): void {
  replayRecordsCache = records;
}

/**
 * Returns recorded cassette records for the given traceId.
 * Used by server-side replay (e.g. Express middleware) to prime the matcher per request.
 */
export function getRecordsForTrace(traceId: string): SoftprobeCassetteRecord[] {
  return replayRecordsCache.filter((r) => r.traceId === traceId);
}

/** Global matcher used in REPLAY mode when no ALS context (e.g. server request). Set by init. */
let globalReplayMatcher: SoftprobeMatcher | undefined;

/**
 * Sets the global replay matcher (used by REPLAY init so getActiveMatcher returns it when ALS has no context).
 */
export function setGlobalReplayMatcher(matcher: SoftprobeMatcher | undefined): void {
  globalReplayMatcher = matcher;
}

/**
 * Primes the active matcher with records for the given traceId.
 * Called by server middleware (Express/Fastify) when SOFTPROBE_MODE=REPLAY so subsequent outbound calls use the right cassette.
 */
export function activateReplayForContext(traceId: string): void {
  const matcher = getActiveMatcher();
  if (matcher && '_setRecords' in matcher) {
    (matcher as SoftprobeMatcher)._setRecords(getRecordsForTrace(traceId));
  }
}

export const softprobe = {
  runWithContext,
  getReplayContext,
  setReplayContext,
  clearReplayContext,
  getActiveMatcher,
  getRecordedInboundResponse,
  getRecordsForTrace,
  setReplayRecordsCache,
  setGlobalReplayMatcher,
  activateReplayForContext,
};
