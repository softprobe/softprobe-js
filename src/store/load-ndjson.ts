/**
 * Streams NDJSON from a file and returns parsed cassette records.
 * When traceId is provided, only records with that traceId are returned.
 */

import fs from 'fs';
import readline from 'readline';

import type { SoftprobeCassetteRecord } from '../types/schema';

/**
 * Loads records from an NDJSON file. Uses readline for streaming.
 * When traceId is undefined, returns all records; otherwise only records matching traceId.
 */
export async function loadNdjson(
  path: string,
  traceId?: string
): Promise<SoftprobeCassetteRecord[]> {
  const out: SoftprobeCassetteRecord[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(path),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as SoftprobeCassetteRecord;
    if (traceId === undefined) {
      out.push(rec);
    } else if (traceId === '') {
      if (!rec.traceId || rec.traceId === '') out.push(rec);
    } else if (rec.traceId && rec.traceId.toLowerCase() === traceId.toLowerCase()) {
      out.push(rec);
    }
  }
  return out;
}
