/**
 * Replay-mode record store accessor. Eager-loaded at boot (REPLAY init or tests);
 * middleware retrieves only records for the current traceId. Task 15.3.1.
 */

import type { SoftprobeCassetteRecord } from '../types/schema';

/** Eager-loaded global store; set at boot (or by tests). */
let replayRecordsCache: SoftprobeCassetteRecord[] = [];

/**
 * Sets the global replay records cache (used at REPLAY boot or by tests).
 * Design §16.1: middleware primes matcher from records for the request traceId.
 */
export function setReplayRecordsCache(records: SoftprobeCassetteRecord[]): void {
  replayRecordsCache = records;
}

/**
 * Returns recorded cassette records for the given traceId.
 * Used by server-side replay (Express/Fastify middleware) to prime the matcher per request.
 * Compares traceIds in lowercase so W3C traceparent propagation (lowercase) matches cassette records.
 */
export function getRecordsForTrace(traceId: string): SoftprobeCassetteRecord[] {
  const normalized = traceId.toLowerCase();
  return replayRecordsCache.filter((r) => r.traceId.toLowerCase() === normalized);
}
