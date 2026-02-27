/**
 * Express middleware for Softprobe: capture path taps res.send; replay path primes matcher by traceId.
 * Design §16.1: CAPTURE → queueInboundResponse; REPLAY → activateReplayForContext(traceId).
 * Task 17.3.2: Set OTel softprobe context so downstream code can use SoftprobeContext.
 */

import { context, trace } from '@opentelemetry/api';
import { activateReplayForContext } from './replay';
import { SoftprobeContext } from '../../context';
import { resolveRequestStorageForContext } from '../../core/cassette/context-request-storage';
import {
  CaptureEngine,
  queueInboundResponse,
  type QueueInboundResponsePayload,
} from '../common/http/inbound-capture';
import { buildInboundHttpIdentifier } from '../common/http/span-adapter';

export { CaptureEngine, queueInboundResponse };
export type { QueueInboundResponsePayload };

/**
 * Environment-aware Express middleware. Replay uses cassetteDirectory + traceId (from context/headers);
 * storage is resolved per request and SoftprobeContext.run loads the cassette in REPLAY mode.
 * In CAPTURE mode wraps res.send to record status/body via CaptureEngine.queueInboundResponse.
 * When placed after body-parser, req.body is captured in the inbound record (Task 14.3.1).
 * Task 17.3.2: Runs the whole request inside OTel context and does not return until res.end() so
 * downstream code (route handlers, MSW fetch listener) sees the same SoftprobeContext state.
 */
export function softprobeExpressMiddleware(
  req: { method: string; path: string; body?: unknown; headers?: Record<string, string | string[] | undefined> },
  res: { statusCode: number; send: (body?: unknown) => unknown },
  next: (err?: unknown) => void
): void | Promise<void> {
  const span = trace.getActiveSpan();
  const spanTraceId = span?.spanContext().traceId;
  const base = SoftprobeContext.active();
  const withTrace = { ...base, traceId: spanTraceId };
  const fromHeadersValue = SoftprobeContext.fromHeaders(withTrace, req.headers ?? {});
  // Trace id from header (replay CLI) or OTel active span.
  const traceId = fromHeadersValue.traceId ?? spanTraceId;
  const softprobeValue = { ...fromHeadersValue, traceId };
  const activeCtx = context.active();
  const ctxWithSoftprobe = SoftprobeContext.withData(activeCtx, softprobeValue);

  const ctxTraceId = SoftprobeContext.getTraceId(ctxWithSoftprobe);
  if (!ctxTraceId) {
    console.error('Softprobe: trace id required. Trace id is not set in the context.');
    process.exit(1);
  }

  const mode = SoftprobeContext.getMode(ctxWithSoftprobe);
  const { storage } = resolveRequestStorageForContext(req.headers, activeCtx, ctxTraceId);
  const runOptions = { mode, traceId: ctxTraceId, storage } as const;

  // Run the whole request inside OTel context and do not return until res.end() so that
  // downstream (e.g. MSW fetch listener) sees the same context (design: OTel context only).
  type ResWithEnd = { end?: (chunk?: unknown, encoding?: string, cb?: () => void) => unknown };
  const waitForResponseThenNext = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const origEnd = (res as ResWithEnd).end?.bind(res);
      if (typeof origEnd === 'function') {
        (res as ResWithEnd).end = function (this: ResWithEnd, chunk?: unknown, encoding?: string, cb?: () => void) {
          (res as ResWithEnd).end = origEnd;
          const result = origEnd!.call(this, chunk, encoding, cb);
          resolve();
          return result;
        };
      } else {
        resolve();
      }
      next();
    });

  const promise = context.with(ctxWithSoftprobe, () =>
    SoftprobeContext.run(runOptions, async () => {
      if (mode === 'REPLAY') {
        activateReplayForContext(ctxTraceId);
      }
      if (mode === 'CAPTURE') {
        const originalSend = res.send.bind(res);
        res.send = function (body?: unknown) {
          CaptureEngine.queueInboundResponse(ctxTraceId, {
            status: res.statusCode,
            body,
            identifier: buildInboundHttpIdentifier(req.method, req.path),
            requestBody: req.body,
          });
          return originalSend.apply(res, arguments as any);
        };
      }
      await waitForResponseThenNext();
    })
  );
  return Promise.resolve(promise).catch((err: unknown) => next(err));
}
