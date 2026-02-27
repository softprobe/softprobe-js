import type { SoftprobeCassetteRecord, SoftprobeRunOptions } from './types/schema';
import type { SemanticMatcher } from './core/matcher/matcher';
import { SoftprobeMatcher } from './core/matcher/softprobe-matcher';
import { getContextWithReplayBaggage } from './api/baggage';
import { compareInboundWithRecord, type CompareInboundInput } from './api/compare';
import { getRecordsForTrace as getRecordsForTraceFromStore } from './core/matcher/store-accessor';
import { SoftprobeContext } from './context';

/**
 * Returns the current replay context for the active async scope from OTel context.
 * Stored in OTel context by SoftprobeContext.withData/run.
 */
export function getContext():
  | ReturnType<typeof SoftprobeContext.active>
  | undefined {
  return {
    mode: SoftprobeContext.getMode(),
    storage: SoftprobeContext.getCassette(),
    traceId: SoftprobeContext.getTraceId(),
    strictReplay: SoftprobeContext.getStrictReplay(),
    strictComparison: SoftprobeContext.getStrictComparison(),
    matcher: SoftprobeContext.getMatcher(),
    inboundRecord: SoftprobeContext.getInboundRecord(),
  };
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
 * Returns recorded cassette records for the given traceId from the active context only.
 * Records are context-scoped (matcher is created by SoftprobeContext.run(REPLAY)). Task 15.3.1.
 */
export function getRecordsForTrace(traceId: string): SoftprobeCassetteRecord[] {
  return getRecordsForTraceFromStore(traceId);
}

/**
 * Sets the global replay matcher. For test/cleanup only; the framework creates matchers in SoftprobeContext.run(REPLAY).
 * getMatcher() returns only the context matcher, not this global.
 */
export function setGlobalReplayMatcher(matcher: SoftprobeMatcher | undefined): void {
  SoftprobeContext.setGlobalReplayMatcher(matcher);
}

/**
 * Primes the active matcher with records for the given traceId.
 * Called by server middleware (Express/Fastify) after run(); the matcher was already seeded in run(), so this is a no-op when records are present.
 */
export function activateReplayForContext(traceId: string): void {
  const matcher = getActiveMatcher();
  if (matcher && '_setRecords' in matcher) {
    const records = getRecordsForTrace(traceId);
    if (records.length > 0) {
      (matcher as SoftprobeMatcher)._setRecords(records);
    }
  }
}

/**
 * No-op. Replay is context-scoped; only SoftprobeContext.run(REPLAY) creates and seeds the matcher.
 * Use cassetteDirectory + traceId and middleware so each request gets its own context and matcher.
 */
export async function ensureReplayLoadedForRequest(): Promise<void> {}

/** Runs callback inside a scoped Softprobe context using SoftprobeRunOptions. */
export function run<T>(options: SoftprobeRunOptions, fn: () => T | Promise<T>): T | Promise<T> {
  return SoftprobeContext.run(options, fn);
}

export { getContextWithReplayBaggage } from './api/baggage';

export const softprobe = {
  getContext,
  getActiveMatcher,
  getRecordedInboundResponse,
  compareInbound,
  getRecordsForTrace,
  setGlobalReplayMatcher,
  activateReplayForContext,
  ensureReplayLoadedForRequest,
  run,
  getContextWithReplayBaggage,
};
