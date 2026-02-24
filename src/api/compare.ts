/**
 * Task 15.2.1: Inbound comparison utility.
 * Retrieves the recorded inbound record and performs deep equality check on status and body.
 */
import { getSoftprobeContext } from '../context';
import type { SoftprobeCassetteRecord } from '../types/schema';

export type CompareInboundInput = {
  /** HTTP status code of the actual response. */
  status: number;
  /** Parsed response body (e.g. from res.json() or res.text()). */
  body: unknown;
  /** Optional response headers. Compared when getSoftprobeContext().strictComparison is set (Task 15.2.2). */
  headers?: Record<string, string>;
};

/**
 * Recorded inbound may use responsePayload.status (Express) or responsePayload.statusCode (http-inbound).
 */
function getRecordedStatus(record: { responsePayload?: unknown; statusCode?: number }): number | undefined {
  const payload = record.responsePayload as { status?: number; statusCode?: number } | undefined;
  return payload?.status ?? payload?.statusCode ?? record.statusCode;
}

function getRecordedBody(record: { responsePayload?: unknown }): unknown {
  const payload = record.responsePayload as { body?: unknown } | undefined;
  return payload?.body;
}

function getRecordedHeaders(record: { responsePayload?: unknown }): Record<string, string> | undefined {
  const payload = record.responsePayload as { headers?: Record<string, string> } | undefined;
  return payload?.headers;
}

function isStrictComparison(): boolean {
  return getSoftprobeContext().strictComparison === true;
}

/** Normalize header keys to lowercase for comparison. */
function normalizeHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

/**
 * Compares the actual response (status and body) to the given recorded inbound record.
 * Deep equality is used for body. Used by softprobe.compareInbound() with getRecordedInboundResponse().
 * @throws When recorded is missing, or when status or body does not match.
 */
export function compareInboundWithRecord(
  actual: CompareInboundInput,
  recorded: SoftprobeCassetteRecord | undefined
): void {
  if (!recorded) {
    throw new Error('compareInbound: no recorded inbound response for this trace');
  }
  const expectedStatus = getRecordedStatus(recorded);
  const expectedBody = getRecordedBody(recorded);
  if (expectedStatus !== undefined && actual.status !== expectedStatus) {
    throw new Error(
      `compareInbound: status mismatch (actual ${actual.status}, expected ${expectedStatus})`
    );
  }
  if (!deepEqual(actual.body, expectedBody)) {
    throw new Error(
      'compareInbound: body mismatch (actual and recorded response bodies are not deep equal)'
    );
  }
  if (isStrictComparison()) {
    const expectedHeaders = getRecordedHeaders(recorded);
    if (expectedHeaders !== undefined && Object.keys(expectedHeaders).length > 0) {
      const actualHeaders = actual.headers ?? {};
      const normExpected = normalizeHeaders(expectedHeaders);
      const normActual = normalizeHeaders(actualHeaders);
      if (!deepEqual(normActual, normExpected)) {
        throw new Error(
          'compareInbound: header mismatch (actual and recorded response headers are not equal in strict mode)'
        );
      }
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  const keysA = Object.keys(a as object).sort();
  const keysB = Object.keys(b as object).sort();
  if (keysA.length !== keysB.length || keysA.some((k, i) => k !== keysB[i])) {
    return false;
  }
  return keysA.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}
