/**
 * Task 13.10: Test helper to read cassette file at path using Cassette only (no loadNdjson).
 * Uses SoftprobeContext.getOrCreateCassette(dir, traceId).loadTrace() for {dir}/{traceId}.ndjson.
 */

import path from 'path';
import type { SoftprobeCassetteRecord } from '../../types/schema';
import { SoftprobeContext } from '../../context';

export async function loadCassetteRecordsByPath(
  filePath: string
): Promise<SoftprobeCassetteRecord[]> {
  const dir = path.dirname(filePath);
  const traceId = path.basename(filePath, '.ndjson');
  const cassette = SoftprobeContext.getOrCreateCassette(dir, traceId);
  return cassette.loadTrace();
}
