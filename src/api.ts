import { AsyncLocalStorage } from 'async_hooks';
import { propagation } from '@opentelemetry/api';
import type { SoftprobeCassetteRecord } from './types/schema';
import type { SemanticMatcher } from './replay/matcher';
import { SoftprobeMatcher } from './replay/softprobe-matcher';
import { createDefaultMatcher } from './replay/extract-key';
import { loadNdjson } from './store/load-ndjson';
import { getCaptureStore } from './capture/store-accessor';
import { getContextWithReplayBaggage } from './api/baggage';
import { compareInboundWithRecord, type CompareInboundInput } from './api/compare';
import {
  getRecordsForTrace as getRecordsForTraceFromStore,
  setReplayRecordsCache as setReplayRecordsCacheInStore,
} from './replay/store-accessor';

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
 * Task 15.1.2: When OTel baggage contains softprobe-mode=REPLAY, also returns globalReplayMatcher so
 * downstream services (receiving propagated baggage) use the global matcher for outbound calls.
 */
export function getActiveMatcher(): SemanticMatcher | SoftprobeMatcher | undefined {
  const ctx = getReplayContext();
  if (ctx?.matcher) return ctx.matcher;
  if (process.env.SOFTPROBE_MODE === 'REPLAY' && globalReplayMatcher) return globalReplayMatcher;
  const baggageMode = propagation.getActiveBaggage()?.getEntry('softprobe-mode')?.value;
  if (baggageMode === 'REPLAY' && globalReplayMatcher) return globalReplayMatcher;
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

/**
 * Task 15.2.1: Compares the actual response (status and body) to the recorded inbound for the current trace.
 * Task 15.2.2: When SOFTPROBE_STRICT_COMPARISON is set, also compares headers.
 * @throws When no recorded inbound exists, or when status, body, or (if strict) headers do not match.
 */
export function compareInbound(actual: CompareInboundInput): void {
  compareInboundWithRecord(actual, getRecordedInboundResponse());
}

/**
 * Sets the global replay records cache (used at REPLAY boot or tests).
 * Task 15.3.1: store lives in replay/store-accessor; middleware retrieves via getRecordsForTrace.
 */
export function setReplayRecordsCache(records: SoftprobeCassetteRecord[]): void {
  setReplayRecordsCacheInStore(records);
}

/**
 * Returns recorded cassette records for the given traceId from the eager-loaded global store.
 * Used by server middleware to prime the matcher for the current request. Task 15.3.1.
 */
export function getRecordsForTrace(traceId: string): SoftprobeCassetteRecord[] {
  return getRecordsForTraceFromStore(traceId);
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

/**
 * Flushes the capture cassette store to disk. Call before process.exit in CAPTURE mode
 * (e.g. from a /exit route) so the NDJSON file is written. Design §16.2 example.
 */
export function flushCapture(): void {
  getCaptureStore()?.flushOnExit();
}

export { getContextWithReplayBaggage } from './api/baggage';

export const softprobe = {
  runWithContext,
  getReplayContext,
  setReplayContext,
  clearReplayContext,
  getActiveMatcher,
  getRecordedInboundResponse,
  compareInbound,
  getRecordsForTrace,
  setReplayRecordsCache,
  setGlobalReplayMatcher,
  activateReplayForContext,
  flushCapture,
  getContextWithReplayBaggage,
};
