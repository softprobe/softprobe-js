import { trace } from '@opentelemetry/api';
import type { Cassette, SoftprobeCassetteRecord, SoftprobeMode } from '../../../types/schema';
import { SoftprobeContext } from '../../../context';
import { httpIdentifier } from '../../../core/identifier';
import { shouldCaptureBody } from '../../../core/runtime/http-body';

export type QueueInboundResponsePayload = {
  status: number;
  body: unknown;
  identifier: string;
  /** Parsed request body when middleware is placed after body-parser (Task 14.3.1). */
  requestBody?: unknown;
  /** Request body size in bytes when known from transport headers. */
  requestBodyBytes?: number;
  /** Response body size in bytes when known from transport headers. */
  responseBodyBytes?: number;
};

export type InboundCaptureSnapshot = {
  mode: SoftprobeMode;
  traceId: string;
  cassette?: Cassette;
};

/**
 * Queues an inbound HTTP response for capture. Writes one NDJSON record via the capture store.
 * Uses active span context for traceId/spanId when not provided in payload.
 */
export function queueInboundResponse(
  traceId: string,
  payload: QueueInboundResponsePayload,
  snapshot?: InboundCaptureSnapshot
): void {
  const span = trace.getActiveSpan();
  const spanId = span?.spanContext().spanId ?? '';

  const [method, ...urlParts] = payload.identifier.split(' ');
  const url = urlParts.join(' ') || '/';
  const cassette = snapshot?.cassette ?? SoftprobeContext.getCassette();
  const mode = snapshot?.mode ?? SoftprobeContext.getMode();
  if (mode !== 'CAPTURE' || !cassette) return;
  const record: SoftprobeCassetteRecord = {
    version: '4.1',
    traceId,
    spanId,
    timestamp: new Date().toISOString(),
    type: 'inbound',
    protocol: 'http',
    identifier: httpIdentifier(method, url),
    responsePayload: {
      statusCode: payload.status,
      ...(shouldCaptureBody(payload.body, payload.responseBodyBytes) && { body: payload.body }),
    },
    ...(shouldCaptureBody(payload.requestBody, payload.requestBodyBytes) && {
      requestPayload: { body: payload.requestBody },
    }),
  };
  const tid = snapshot?.traceId ?? SoftprobeContext.getTraceId();
  void cassette.saveRecord(tid ? { ...record, traceId: tid } : record).catch(() => {});
}

/** Engine object for design alignment; used by Express and Fastify. */
export const CaptureEngine = {
  queueInboundResponse,
};
