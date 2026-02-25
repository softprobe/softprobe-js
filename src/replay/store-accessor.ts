/**
 * Replay-mode record store accessor. Eager-loaded at boot (REPLAY init or tests)
 * or on demand when request has x-softprobe-mode=REPLAY + x-softprobe-cassette-path.
 * Middleware retrieves only records for the current traceId. Task 15.3.1.
 */

import type { SoftprobeCassetteRecord } from '../types/schema';
import { loadNdjson } from '../store/load-ndjson';

/** Eager-loaded or on-demand loaded global store. */
let replayRecordsCache: SoftprobeCassetteRecord[] = [];

/** Cache by cassette path for on-demand replay (request-only replay via headers). */
const pathCache = new Map<string, SoftprobeCassetteRecord[]>();

/**
 * Sets the global replay records cache (used at REPLAY boot, on-demand load, or tests).
 * Design §16.1: middleware primes matcher from records for the request traceId.
 */
export function setReplayRecordsCache(records: SoftprobeCassetteRecord[]): void {
  replayRecordsCache = records;
}

/**
 * Loads records from a cassette path, with in-memory cache by path.
 * Used when request has x-softprobe-mode=REPLAY and x-softprobe-cassette-path (no server REPLAY boot required).
 */
export async function loadReplayRecordsFromPath(path: string): Promise<SoftprobeCassetteRecord[]> {
  const cached = pathCache.get(path);
  if (cached) return cached;
  const records = await loadNdjson(path);
  pathCache.set(path, records);
  return records;
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
