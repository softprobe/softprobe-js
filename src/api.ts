import type { Cassette, SoftprobeCassetteRecord, SoftprobeRunOptions } from './types/schema';
import type { SemanticMatcher } from './replay/matcher';
import { SoftprobeMatcher } from './replay/softprobe-matcher';
import { getCaptureStore } from './capture/store-accessor';
import { getContextWithReplayBaggage } from './api/baggage';
import { compareInboundWithRecord, type CompareInboundInput } from './api/compare';
import {
  getRecordsForTrace as getRecordsForTraceFromStore,
  setReplayRecordsCache as setReplayRecordsCacheInStore,
  loadReplayRecordsFromPath,
} from './replay/store-accessor';
import { createDefaultMatcher } from './replay/extract-key';
import { SoftprobeContext } from './context';

/**
 * Input shape for replay context. traceId and cassettePath are used by
 * runWithContext; matcher and inboundRecord are set when records are loaded (Task 8.2).
 * Stored in OTel context via SoftprobeContext.
 */
export interface ReplayContext {
  traceId?: string;
  cassettePath?: string;
  /** Optional mode (CAPTURE | REPLAY | PASSTHROUGH); when set, stored in OTel context. */
  mode?: 'CAPTURE' | 'REPLAY' | 'PASSTHROUGH';
  /** Optional strict flags; when set, stored in OTel context. */
  strictReplay?: boolean;
  strictComparison?: boolean;
  /** Optional matcher for replay; when set, getActiveMatcher() returns it. */
  matcher?: SemanticMatcher | SoftprobeMatcher;
  /** Cached inbound record for this trace; used by getRecordedInboundResponse(). */
  inboundRecord?: SoftprobeCassetteRecord;
}

const noOpCassette: Cassette = {
  loadTrace: async () => [],
  saveRecord: async () => {},
};

/**
 * Test-time API: run a function with the given replay context so that
 * concurrent tests (e.g. different workers) do not share matcher state.
 * When context.cassettePath is set, loads records once from NDJSON and sets
 * them on a SoftprobeMatcher before running the callback (Task 8.2.1).
 * Delegates to SoftprobeContext.run (design-context.md).
 */
export function runWithContext<T>(
  replayContext: ReplayContext,
  fn: () => T | Promise<T>
): T | Promise<T> {
  const options: SoftprobeRunOptions = {
    mode: replayContext.mode ?? 'PASSTHROUGH',
    storage: noOpCassette,
    traceId: replayContext.traceId ?? '',
  };
  return SoftprobeContext.run(options, fn);
}

/**
 * Returns the current replay context for the active async scope from OTel context.
 * Same shape as ReplayContext; when not inside runWithContext, returns global default.
 */
export function getReplayContext(): ReplayContext | undefined {
  return SoftprobeContext.active() as ReplayContext | undefined;
}

/**
 * Returns the active matcher for the current replay context, if any.
 * In REPLAY mode, returns global matcher when context has no matcher; includes baggage fallback.
 */
export function getActiveMatcher(): SemanticMatcher | SoftprobeMatcher | undefined {
  return SoftprobeContext.getMatcher();
}

/**
 * Returns the recorded inbound response for the current trace, if any.
 * Set by runWithContext when loading a cassette that contains a record with type "inbound".
 */
export function getRecordedInboundResponse(): SoftprobeCassetteRecord | undefined {
  return SoftprobeContext.getInboundRecord();
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

/**
 * Sets the global replay matcher (used by REPLAY init so getActiveMatcher returns it when context has no matcher).
 */
export function setGlobalReplayMatcher(matcher: SoftprobeMatcher | undefined): void {
  SoftprobeContext.setGlobalReplayMatcher(matcher);
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
 * Loads the cassette from cassettePath (with cache) and sets the replay store and global matcher.
 * Called by middleware when request has x-softprobe-mode=REPLAY and x-softprobe-cassette-path
 * so replay works for that request without requiring the server to be started with SOFTPROBE_MODE=REPLAY.
 */
export async function ensureReplayLoadedForRequest(cassettePath: string): Promise<void> {
  const records = await loadReplayRecordsFromPath(cassettePath);
  setReplayRecordsCache(records);
  if (!getActiveMatcher()) {
    const matcher = new SoftprobeMatcher();
    matcher.use(createDefaultMatcher());
    setGlobalReplayMatcher(matcher);
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
  getActiveMatcher,
  getRecordedInboundResponse,
  compareInbound,
  getRecordsForTrace,
  setReplayRecordsCache,
  setGlobalReplayMatcher,
  activateReplayForContext,
  ensureReplayLoadedForRequest,
  flushCapture,
  getContextWithReplayBaggage,
};
