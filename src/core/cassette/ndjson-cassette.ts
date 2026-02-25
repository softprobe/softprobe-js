import fs from 'fs/promises';
import type { SoftprobeCassetteRecord } from '../../types/schema';
import { loadNdjson } from '../../store/load-ndjson';

type NdjsonCassetteWriter = {
  appendLine?: (line: string) => void | Promise<void>;
  flush?: () => void | Promise<void>;
};

/**
 * NDJSON-backed cassette adapter for replay trace loading.
 */
export class NdjsonCassette {
  constructor(
    private readonly path: string,
    private readonly writer: NdjsonCassetteWriter = {}
  ) {}

  /**
   * Loads only records that belong to the provided trace id.
   */
  async loadTrace(traceId: string): Promise<SoftprobeCassetteRecord[]> {
    return loadNdjson(this.path, traceId);
  }

  /**
   * Appends a single record as one NDJSON line.
   */
  async saveRecord(
    traceId: string,
    record: SoftprobeCassetteRecord
  ): Promise<void> {
    const serialized = JSON.stringify({ ...record, traceId }) + '\n';
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
