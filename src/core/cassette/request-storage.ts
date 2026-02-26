import path from 'path';
import { NdjsonCassette } from './ndjson-cassette';
import type { Cassette } from '../../types/schema';

const HEADER_CASSETTE_PATH = 'x-softprobe-cassette-path';

type HeaderMap = Record<string, string | string[] | undefined>;

/**
 * Reads the optional cassette path coordination header from request headers.
 */
export function readCassettePathHeader(
  headers: HeaderMap | undefined
): string | undefined {
  const value = headers?.[HEADER_CASSETTE_PATH];
  if (typeof value === 'string' && value) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0]) return value[0];
  return undefined;
}

/**
 * Resolves request-scoped cassette storage from existing storage, coordination headers, and a caller-provided fallback cassette.
 */
export function resolveRequestStorage(input: {
  headers?: HeaderMap;
  existingCassette?: Cassette;
  configuredCassette?: Cassette;
}): { storage: Cassette; cassettePathHeader?: string } {
  const cassettePathHeader = readCassettePathHeader(input.headers);
  if (cassettePathHeader) {
    const dir = path.dirname(cassettePathHeader);
    const traceId = path.basename(cassettePathHeader, '.ndjson');
    return { storage: new NdjsonCassette(dir, traceId), cassettePathHeader };
  }
  if (input.existingCassette) return { storage: input.existingCassette, cassettePathHeader };
  if (input.configuredCassette) return { storage: input.configuredCassette, cassettePathHeader };
  throw new Error('Softprobe cassette storage is not configured. Provide x-softprobe-cassette-path or configured storage.');
}
