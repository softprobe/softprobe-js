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
 * bytes and a truncated flag. Does not consume the original stream - the
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

  source.on('data', (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (length < maxPayloadSize) {
      const remain = maxPayloadSize - length;
      if (buf.length <= remain) {
        chunks.push(buf);
        length += buf.length;
      } else {
        chunks.push(buf.subarray(0, remain));
        length += remain;
        truncated = true;
      }
    } else {
      truncated = true;
    }
  });

  const finalize = () => {
    if (settled) return;
    settled = { body: Buffer.concat(chunks, length), truncated };
    resolveCaptured(settled);
  };

  source.once('end', finalize);
  source.once('error', finalize);
  source.once('close', finalize);

  source.pipe(out);

  return {
    readable: out,
    getCaptured: () => (settled !== undefined ? Promise.resolve(settled) : capturedPromise),
  };
}
