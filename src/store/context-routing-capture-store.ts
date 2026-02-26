/**
 * Task 16.2.1: Capture store that routes writes by OTel context.
 * When SoftprobeContext.getMode() === 'CAPTURE' and a cassette is present in context,
 * writes go through that cassette instance for the active trace.
 */

import { SoftprobeContext } from '../context';
import type { SoftprobeCassetteRecord } from '../types/schema';
const seenCassettes = new Set<NonNullable<ReturnType<typeof SoftprobeContext.getCassette>>>();

/**
 * Proxy that implements CassetteStore interface and routes by context.
 * saveRecord(record) only writes when context.mode === 'CAPTURE' and context.cassette exists.
 */
export const contextRoutingCaptureStore: {
  saveRecord: (record: SoftprobeCassetteRecord) => void;
  flush: () => void;
  flushOnExit: () => void;
} = {
  saveRecord(record: SoftprobeCassetteRecord): void {
    if (SoftprobeContext.getMode() !== 'CAPTURE') return;
    const cassette = SoftprobeContext.getCassette();
    const traceId = SoftprobeContext.getTraceId();
    if (!cassette || !traceId) return;
    seenCassettes.add(cassette);
    void cassette.saveRecord(record).catch(() => {
      // best-effort
    });
  },

  flush(): void {
    for (const cassette of seenCassettes.values()) {
      void cassette.flush?.().catch(() => {
        // best-effort
      });
    }
  },

  flushOnExit(): void {
    try {
      contextRoutingCaptureStore.flush();
    } catch {
      // best-effort
    }
  },
};
