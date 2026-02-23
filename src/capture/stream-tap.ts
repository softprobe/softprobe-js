/**
 * Safe stream tap for HTTP capture. Tees a Readable so the original consumer
 * receives the full stream while we collect bytes for the side-channel, with
 * a maxPayloadSize cap. Design §10.2: PassThrough/tee pattern, payload max-size
 * circuit breaker, do not starve original stream consumers.
 */

import { PassThrough, Readable } from 'stream';

export type TapReadableStreamOptions = {
  /** Maximum bytes to retain; excess is dropped and truncated=true. */
  maxPayloadSize: number;
};

export type TapCaptured = {
  /** Collected body (capped at maxPayloadSize). */
  body: Buffer;
  /** True when stream length exceeded maxPayloadSize. */
  truncated: boolean;
};

/**
 * Taps a Node Readable stream: returns a stream that delivers the same data to
 * the consumer, and a getCaptured() that resolves with up to maxPayloadSize
 * bytes and a truncated flag. Does not consume the original stream — the
 * returned readable is the stream the consumer should read from.
 */
export function tapReadableStream(
  source: Readable,
  options: TapReadableStreamOptions
): { readable: Readable; getCaptured: () => Promise<TapCaptured> } {
  const { maxPayloadSize } = options;
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  let length = 0;
  let truncated = false;
  let settled: TapCaptured | undefined;
  let resolveCaptured: (value: TapCaptured) => void;
  const capturedPromise = new Promise<TapCaptured>((resolve) => {
    resolveCaptured = resolve;
  });

  function finish() {
    if (settled !== undefined) return;
    settled = { body: Buffer.concat(chunks), truncated };
    resolveCaptured(settled);
  }

  source.on('data', (chunk: Buffer | Uint8Array | string) => {
    out.write(chunk);
    if (length >= maxPayloadSize) {
      truncated = true;
      return;
    }
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const take = Math.min(b.length, maxPayloadSize - length);
    if (take > 0) {
      chunks.push(b.subarray(0, take));
      length += take;
    }
    if (b.length > take) truncated = true;
  });
  source.on('end', () => {
    out.end();
    finish();
  });
  source.on('error', (err) => {
    out.destroy(err);
    finish();
  });

  return {
    readable: out,
    getCaptured: () => (settled !== undefined ? Promise.resolve(settled) : capturedPromise),
  };
}
