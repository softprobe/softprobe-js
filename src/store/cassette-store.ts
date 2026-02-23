/**
 * Single-threaded FIFO queue that appends NDJSON lines to a file.
 * Used as the capture side-channel; payloads are not stored in span attributes.
 */

import fs from 'fs';

import type { SoftprobeCassetteRecord } from '../types/schema';

export type CassetteStoreOptions = {
  /** When set, enqueue drops lines once queue reaches this size and increments drop count. */
  maxQueueSize?: number;
};

/**
 * CassetteStore enqueues NDJSON lines and flushes them to a file in order.
 */
export class CassetteStore {
  private readonly path: string;
  private readonly queue: string[] = [];
  private readonly maxQueueSize: number | undefined;
  private dropCount = 0;
  private readonly _boundFlushOnExit: () => void;

  constructor(outputPath: string, options: CassetteStoreOptions = {}) {
    this.path = outputPath;
    this.maxQueueSize = options.maxQueueSize;
    this._boundFlushOnExit = this.flushOnExit.bind(this);
    process.on('SIGINT', this._boundFlushOnExit);
    process.on('SIGTERM', this._boundFlushOnExit);
  }

  /** Appends a line (one JSON record) to the FIFO queue. Drops and counts if at maxQueueSize. */
  enqueue(line: string): void {
    if (
      this.maxQueueSize !== undefined &&
      this.queue.length >= this.maxQueueSize
    ) {
      this.dropCount += 1;
      return;
    }
    this.queue.push(line);
  }

  /** Returns the number of lines dropped due to maxQueueSize. */
  getDropCount(): number {
    return this.dropCount;
  }

  /**
   * Serializes a cassette record as one JSON line. The line is queued for flush;
   * flush joins with newline so the file has exactly one JSON per line.
   */
  saveRecord(record: SoftprobeCassetteRecord): void {
    this.enqueue(JSON.stringify(record));
  }

  /** Writes all queued lines to the output file in order, then clears the queue. */
  flush(): void {
    if (this.queue.length === 0) return;
    const content = this.queue.join('\n') + (this.queue.length ? '\n' : '');
    fs.appendFileSync(this.path, content, 'utf8');
    this.queue.length = 0;
  }

  /**
   * Best-effort flush on exit. Registered for SIGINT/SIGTERM; safe to call directly (e.g. in tests).
   */
  flushOnExit(): void {
    try {
      this.flush();
    } catch {
      // best-effort: avoid throwing on process exit
    }
  }
}
