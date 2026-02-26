import fs from 'fs/promises';
import path from 'path';
import type { SoftprobeCassetteRecord } from '../../types/schema';
import { loadNdjson } from '../../store/load-ndjson';

type NdjsonCassetteWriter = {
  appendLine?: (line: string) => void | Promise<void>;
  flush?: () => void | Promise<void>;
};

/**
 * NDJSON-backed cassette adapter. One file per trace: path = {cassetteDirectory}/{traceId}.ndjson.
 * Task 13.4: constructed with cassetteDirectory and traceId; internal path is derived.
 */
export class NdjsonCassette {
  private readonly path: string;

  constructor(
    cassetteDirectory: string,
    traceId: string,
    private readonly writer: NdjsonCassetteWriter = {}
  ) {
    this.path = path.join(cassetteDirectory, `${traceId}.ndjson`);
  }

  /**
   * Loads all records from this cassette file (cassette is bound to one trace; one file per trace).
   */
  async loadTrace(): Promise<SoftprobeCassetteRecord[]> {
    return loadNdjson(this.path);
  }

  /**
   * Appends a single record as one NDJSON line.
   */
  async saveRecord(record: SoftprobeCassetteRecord): Promise<void> {
    const serialized = JSON.stringify(record) + '\n';
    if (this.writer.appendLine) {
      await this.writer.appendLine(serialized);
      return;
    }
    await fs.appendFile(this.path, serialized, 'utf8');
  }

  /**
   * Flushes the underlying writer queue when a flush hook is available.
   */
  async flush(): Promise<void> {
    if (!this.writer.flush) return;
    await this.writer.flush();
  }
}
