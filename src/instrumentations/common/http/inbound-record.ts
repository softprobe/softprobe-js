/**
 * HTTP inbound capture: write one NDJSON record per inbound request/response.
 * Design §10.4: Inbound HTTP — request body + response status/body.
 * Single record embeds both requestPayload and responsePayload when available.
 * Task 14.3.1: requestPayload.body is populated from req.body when Express
 * middleware is placed after body-parser (via queueInboundResponse.requestBody).
 */

import type { CassetteStore } from '../../../store/cassette-store';
import type { SoftprobeCassetteRecord } from '../../../types/schema';
import { httpIdentifier } from '../../../core/identifier';
import { shouldCaptureBody } from '../../../core/runtime/http-body';

export type WriteInboundHttpOptions = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  spanName?: string;
  method: string;
  url: string;
  /** Request body (optional). */
  requestBody?: unknown;
  /** Request body size in bytes when known from transport headers. */
  requestBodyBytes?: number;
  /** Response status code (optional). */
  statusCode?: number;
  /** Response body (optional). */
  responseBody?: unknown;
  /** Response body size in bytes when known from transport headers. */
  responseBodyBytes?: number;
};

/**
 * Writes one inbound HTTP cassette record. Include requestBody for request capture,
 * and statusCode/responseBody when the response is available (same record).
 */
export function writeInboundHttpRecord(
  store: CassetteStore,
  options: WriteInboundHttpOptions
): void {
  const {
    traceId,
    spanId,
    parentSpanId,
    spanName,
    method,
    url,
    requestBody,
    requestBodyBytes,
    statusCode,
    responseBody,
    responseBodyBytes,
  } = options;

  const record: SoftprobeCassetteRecord = {
    version: '4.1',
    traceId,
    spanId,
    parentSpanId,
    spanName,
    timestamp: new Date().toISOString(),
    type: 'inbound',
    protocol: 'http',
    identifier: httpIdentifier(method, url),
  };

  if (shouldCaptureBody(requestBody, requestBodyBytes)) {
    record.requestPayload = { body: requestBody };
  }
  if (statusCode !== undefined) {
    const responsePayload: { statusCode: number; body?: unknown } = {
      statusCode,
    };
    if (shouldCaptureBody(responseBody, responseBodyBytes)) {
      responsePayload.body = responseBody;
    }
    record.responsePayload = responsePayload;
  }

  store.saveRecord(record);
}
