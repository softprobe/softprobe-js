import { SoftprobeContext } from '../../context';
import type { Cassette } from '../../types/schema';

/**
 * Resolves request-scoped cassette storage from existing storage, configured cassette,
 * or global cassetteDirectory + traceId (Task 13.11). Cassette path is always
 * {cassetteDirectory}/{traceId}.ndjson; no header is used.
 */
export function resolveRequestStorage(input: {
  existingCassette?: Cassette;
  configuredCassette?: Cassette;
  /** When set with traceId, get-or-create cassette for per-trace file. */
  cassetteDirectory?: string;
  traceId?: string;
}): { storage: Cassette } {
  if (input.existingCassette) return { storage: input.existingCassette };
  if (input.configuredCassette) return { storage: input.configuredCassette };
  if (input.cassetteDirectory && input.traceId) {
    return {
      storage: SoftprobeContext.getOrCreateCassette(input.cassetteDirectory, input.traceId),
    };
  }
  throw new Error(
    'Softprobe cassette storage is not configured. Provide configured storage or cassetteDirectory + traceId.'
  );
}
