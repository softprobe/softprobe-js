/**
 * Capture-mode cassette store accessor. Allows hooks to write NDJSON records
 * without coupling them to init. Design §10: payloads written via single-threaded queue.
 *
 * When capture uses the HTTP interceptor (CAPTURE branch with tapReadableStream), the
 * undici responseHook must not write the outbound record — the interceptor is the single writer.
 */

import type { CassetteStore } from '../store/cassette-store';

let captureStore: CassetteStore | undefined;
let captureUsesInterceptorFlag = false;

/** Returns the current capture cassette store, if set (e.g. by init in capture mode). */
export function getCaptureStore(): CassetteStore | undefined {
  return captureStore;
}

/** Sets the capture cassette store (used by init or tests). */
export function setCaptureStore(store: CassetteStore | undefined): void {
  captureStore = store;
}

/** True when CAPTURE uses the HTTP interceptor to write outbound HTTP records (with body). */
export function captureUsesInterceptor(): boolean {
  return captureUsesInterceptorFlag;
}

/** Set when applying the HTTP interceptor in CAPTURE so the undici hook skips saveRecord. */
export function setCaptureUsesInterceptor(value: boolean): void {
  captureUsesInterceptorFlag = value;
}
