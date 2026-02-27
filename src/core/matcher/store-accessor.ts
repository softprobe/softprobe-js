/**
 * Replay-mode record store accessor. Records are context-scoped only: the matcher
 * in the active OTel context holds the loaded records for that request (created by
 * SoftprobeContext.run(REPLAY)). No global cache. Task 15.3.1.
 * Task 13.10: Load via Cassette (getOrCreateCassette) only; no loadNdjson.
 */

import path from 'path';
import type { SoftprobeCassetteRecord } from '../../types/schema';
import { SoftprobeContext } from '../../context';
import type { SoftprobeMatcher } from './softprobe-matcher';

/**
 * Returns recorded cassette records for the given traceId from the active context only.
 * The matcher is created and seeded by SoftprobeContext.run(REPLAY); only the framework creates matchers.
 * Returns [] when there is no active matcher with records. Compares traceIds in lowercase (W3C traceparent).
 */
export function getRecordsForTrace(traceId: string): SoftprobeCassetteRecord[] {
  const normalized = traceId.toLowerCase();
  const matcher = SoftprobeContext.getMatcher();
  if (matcher && '_getRecords' in matcher && typeof (matcher as SoftprobeMatcher)._getRecords === 'function') {
    const contextRecords = (matcher as SoftprobeMatcher)._getRecords();
    return contextRecords.filter((r) => (r.traceId ?? '').toLowerCase() === normalized);
  }
  return [];
}
