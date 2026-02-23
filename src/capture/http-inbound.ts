/**
 * HTTP inbound capture: write one NDJSON record per inbound request/response.
 * Design §10.4: Inbound HTTP — request body + response status/body.
 * Single record embeds both requestPayload and responsePayload when available.
 * Task 14.3.1: requestPayload.body is populated from req.body when Express
 * middleware is placed after body-parser (via queueInboundResponse.requestBody).
 */

import type { CassetteStore } from '../store/cassette-store';
import type { SoftprobeCassetteRecord } from '../types/schema';
import { httpIdentifier } from '../identifier';

export type WriteInboundHttpOptions = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  spanName?: string;
  method: string;
  url: string;
  /** Request body (optional). */
  requestBody?: unknown;
  /** Response status code (optional). */
  statusCode?: number;
  /** Response body (optional). */
  responseBody?: unknown;
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
    statusCode,
    responseBody,
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

  if (requestBody !== undefined) {
    record.requestPayload = { body: requestBody };
  }
  if (statusCode !== undefined) {
    record.responsePayload = {
      statusCode,
      body: responseBody,
    };
  }

  store.saveRecord(record);
}
