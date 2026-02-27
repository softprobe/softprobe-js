/**
 * Capture-mode cassette store accessor. Allows hooks to write NDJSON records
 * without coupling them to init. Design §10: payloads written via single-threaded queue.
 * HTTP outbound capture is done solely via the MSW interceptor (replay/http.ts).
 */

import type { CassetteStore } from '../../store/cassette-store';

let captureStore: CassetteStore | undefined;

/** Returns the current capture cassette store, if set (e.g. by init in capture mode). */
export function getCaptureStore(): CassetteStore | undefined {
  return captureStore;
}

/** Sets the capture cassette store (used by init or tests). */
export function setCaptureStore(store: CassetteStore | undefined): void {
  captureStore = store;
}
