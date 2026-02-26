/**
 * Express middleware for Softprobe: capture path taps res.send; replay path primes matcher by traceId.
 * Design §16.1: CAPTURE → queueInboundResponse; REPLAY → activateReplayForContext(traceId).
 * Task 17.3.2: Set OTel softprobe context so downstream code can use SoftprobeContext.
 */

import { context, trace } from '@opentelemetry/api';
import { getCaptureStore } from './store-accessor';
import { writeInboundHttpRecord } from './http-inbound';
import { activateReplayForContext } from '../replay/express';
import { SoftprobeContext } from '../context';
import { softprobe } from '../api';
import { resolveRequestStorageForContext } from '../core/cassette/context-request-storage';

export type QueueInboundResponsePayload = {
  status: number;
  body: unknown;
  identifier: string;
  /** Parsed request body when middleware is placed after body-parser (Task 14.3.1). */
  requestBody?: unknown;
};

/**
 * Queues an inbound HTTP response for capture. Writes one NDJSON record via the capture store.
 * Uses active span context for traceId/spanId when not provided in payload.
 */
export function queueInboundResponse(
  traceId: string,
  payload: QueueInboundResponsePayload
): void {
  const span = trace.getActiveSpan();
  const spanId = span?.spanContext().spanId ?? '';
  const store = getCaptureStore();
  if (!store) return;

  const [method, ...urlParts] = payload.identifier.split(' ');
  const url = urlParts.join(' ') || '/';

  writeInboundHttpRecord(store, {
    traceId,
    spanId,
    method,
    url,
    requestBody: payload.requestBody,
    statusCode: payload.status,
    responseBody: payload.body,
  });
}

/** Engine object for design alignment; used by Express and Fastify. */
export const CaptureEngine = {
  queueInboundResponse,
};

/**
 * Environment-aware Express middleware. When request has x-softprobe-mode=REPLAY and
 * x-softprobe-cassette-path, loads the cassette on demand and primes the matcher (no server REPLAY boot required).
 * In CAPTURE mode wraps res.send to record status/body via CaptureEngine.queueInboundResponse.
 * When placed after body-parser, req.body is captured in the inbound record (Task 14.3.1).
 * Task 17.3.2: Runs the request in an OTel context with softprobe traceId/mode/storage so SoftprobeContext works downstream.
 */
export function softprobeExpressMiddleware(
  req: { method: string; path: string; body?: unknown; headers?: Record<string, string | string[] | undefined> },
  res: { statusCode: number; send: (body?: unknown) => unknown },
  next: (err?: unknown) => void
): void {
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
  const { storage, cassettePathHeader } = resolveRequestStorageForContext(req.headers, activeCtx);
  const runOptions = { mode, traceId: ctxTraceId, storage } as const;
  const runInRequestScope = (fn: () => void | Promise<void>): void => {
    void Promise.resolve(
      context.with(ctxWithSoftprobe, () => SoftprobeContext.run(runOptions, fn))
    ).catch((err: unknown) => {
      next(err);
    });
  };

  if (mode === 'REPLAY') {
    runInRequestScope(async () => {
        try {
          if (cassettePathHeader) {
            await softprobe.ensureReplayLoadedForRequest(cassettePathHeader);
          }
          activateReplayForContext(ctxTraceId);
        } catch (err) {
          return next(err);
        }
        next();
    });
    return;
  }
  if (mode === 'CAPTURE') {
    runInRequestScope(() => {
        const originalSend = res.send.bind(res);
        res.send = function (body?: unknown) {
          CaptureEngine.queueInboundResponse(ctxTraceId, {
            status: res.statusCode,
            body,
            identifier: `${req.method} ${req.path}`,
            requestBody: req.body,
          });
          return originalSend.apply(res, arguments as any);
        };
        next();
    });
    return;
  }
  runInRequestScope(() => {
    next();
  });
}
