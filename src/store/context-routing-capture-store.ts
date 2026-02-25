/**
 * Task 16.2.1: Capture store that routes writes by OTel context.
 * When SoftprobeContext.getMode() === 'CAPTURE' and cassettePath is set,
 * writes go to a path-specific CassetteStore (created on demand).
 * Used when the app runs in PASSTHROUGH so header-based capture works.
 */

import { SoftprobeContext } from '../context';
import type { SoftprobeCassetteRecord } from '../types/schema';
import { CassetteStore } from './cassette-store';

const DEFAULT_PATH = './softprobe-cassettes.ndjson';

/** Routes saveRecord to a path-specific store based on SoftprobeContext. */
function getStoreForContext(): CassetteStore | undefined {
  if (SoftprobeContext.getMode() !== 'CAPTURE') return undefined;
  const path = SoftprobeContext.getCassettePath()?.trim() || DEFAULT_PATH;
  return getOrCreateStore(path);
}

const pathToStore = new Map<string, CassetteStore>();

function getOrCreateStore(outputPath: string): CassetteStore {
  let store = pathToStore.get(outputPath);
  if (!store) {
    store = new CassetteStore(outputPath);
    pathToStore.set(outputPath, store);
  }
  return store;
}

/**
 * Proxy that implements CassetteStore interface and routes by context.
 * saveRecord(record) only writes when context.mode === 'CAPTURE' and context.cassettePath is set.
 */
export const contextRoutingCaptureStore: {
  saveRecord: (record: SoftprobeCassetteRecord) => void;
  flush: () => void;
  flushOnExit: () => void;
} = {
  saveRecord(record: SoftprobeCassetteRecord): void {
    const store = getStoreForContext();
    if (store) store.saveRecord(record);
  },

  flush(): void {
    for (const store of pathToStore.values()) {
      store.flush();
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
