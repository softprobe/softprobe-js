import fs from 'fs/promises';
import path from 'path';
import type { SoftprobeCassetteRecord } from '../../types/schema';

/** Task 13.10: Read logic lives in cassette layer; one file per trace so no traceId filter. */
async function readNdjsonFile(filePath: string): Promise<SoftprobeCassetteRecord[]> {
  const out: SoftprobeCassetteRecord[] = [];
  try {
    const content = await fs.readFile(filePath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      out.push(JSON.parse(line) as SoftprobeCassetteRecord);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return out;
}

/**
 * NDJSON-backed cassette adapter. One file per trace: path = {cassetteDirectory}/{traceId}.ndjson.
 * Writes directly to disk (no buffer); flush() is a no-op. Optimizations (e.g. buffering) can be added later.
 */
export class NdjsonCassette {
  private readonly path: string;

  constructor(cassetteDirectory: string, traceId: string) {
    this.path = path.join(cassetteDirectory, `${traceId}.ndjson`);
  }

  /**
   * Loads all records from this cassette file (cassette is bound to one trace; one file per trace).
   */
  async loadTrace(): Promise<SoftprobeCassetteRecord[]> {
    return readNdjsonFile(this.path);
  }

  /**
   * Appends a single record as one NDJSON line. Writes directly to the file.
   */
  async saveRecord(record: SoftprobeCassetteRecord): Promise<void> {
    const serialized = JSON.stringify(record) + '\n';
    await fs.appendFile(this.path, serialized, 'utf8');
  }

  /**
   * No-op for direct-write implementation. Optional flush hook for future buffered implementations.
   */
  async flush(): Promise<void> {
    // Direct write; nothing to flush.
  }
}
