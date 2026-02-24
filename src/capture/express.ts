/**
 * Express middleware for Softprobe: capture path taps res.send; replay path primes matcher by traceId.
 * Design §16.1: CAPTURE → queueInboundResponse; REPLAY → activateReplayForContext(traceId).
 * Task 17.3.2: Set OTel softprobe context so downstream code can use getSoftprobeContext().
 */

import { context, trace } from '@opentelemetry/api';
import { getCaptureStore } from './store-accessor';
import { writeInboundHttpRecord } from './http-inbound';
import { activateReplayForContext } from '../replay/express';
import { getSoftprobeContext, setSoftprobeContext, softprobeValueFromHeaders } from '../context';

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
 * Environment-aware Express middleware. In REPLAY mode primes matcher for request traceId;
 * in CAPTURE mode wraps res.send to record status/body via CaptureEngine.queueInboundResponse.
 * When placed after body-parser, req.body is captured in the inbound record (Task 14.3.1).
 * Task 17.3.2: Runs the request in an OTel context with softprobe traceId/mode/cassettePath so getSoftprobeContext() works downstream.
 */
export function softprobeExpressMiddleware(
  req: { method: string; path: string; body?: unknown; headers?: Record<string, string | string[] | undefined> },
  res: { statusCode: number; send: (body?: unknown) => unknown },
  next: () => void
): void {
  const span = trace.getActiveSpan();
  const traceId = span?.spanContext().traceId;
  const base = getSoftprobeContext();
  const withTrace = { ...base, traceId };
  const softprobeValue = softprobeValueFromHeaders(withTrace, req.headers ?? {});
  const activeCtx = context.active();
  const ctxWithSoftprobe = setSoftprobeContext(activeCtx, softprobeValue);

  context.with(ctxWithSoftprobe, () => {
    const ctxTraceId = getSoftprobeContext().traceId ?? traceId;
    if (getSoftprobeContext().mode === 'REPLAY' && ctxTraceId) {
      activateReplayForContext(ctxTraceId);
    }

    if (getSoftprobeContext().mode === 'CAPTURE') {
      const originalSend = res.send.bind(res);
      res.send = function (body?: unknown) {
        CaptureEngine.queueInboundResponse(ctxTraceId ?? '', {
          status: res.statusCode,
          body,
          identifier: `${req.method} ${req.path}`,
          requestBody: req.body,
        });
        return originalSend.apply(res, arguments as any);
      };
    }
    next();
  });
}
