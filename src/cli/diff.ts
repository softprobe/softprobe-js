/**
 * Task 21.2.1: softprobe diff CLI — load cassette inbound, send request with coordination headers.
 * Design §3.1: CLI injects x-softprobe-mode, x-softprobe-trace-id, x-softprobe-cassette-path.
 */

import { loadNdjson } from '../store/load-ndjson';
import type { SoftprobeCassetteRecord } from '../types/schema';

/**
 * Parses HTTP identifier "METHOD url" into { method, url }.
 */
function parseHttpIdentifier(identifier: string): { method: string; url: string } {
  const idx = identifier.indexOf(' ');
  if (idx < 0) return { method: 'GET', url: identifier };
  return {
    method: identifier.slice(0, idx),
    url: identifier.slice(idx + 1),
  };
}

export type RunDiffResult = { response: Response; inbound: SoftprobeCassetteRecord };

/**
 * Loads cassette, finds inbound record, sends request to target with coordination headers.
 * Returns the fetch Response and the inbound record so caller can compare recorded vs live.
 */
export async function runDiff(file: string, target: string): Promise<RunDiffResult> {
  const records = await loadNdjson(file);
  const inbound = records.find((r: SoftprobeCassetteRecord) => r.type === 'inbound');
  if (!inbound) throw new Error("Cassette missing 'inbound' record.");

  const { method, url } = parseHttpIdentifier(inbound.identifier);
  const requestUrl = `${target.replace(/\/$/, '')}${url.startsWith('/') ? url : '/' + url}`;

  const requestPayload = inbound.requestPayload as { body?: unknown } | undefined;
  const body =
    requestPayload?.body !== undefined
      ? (typeof requestPayload.body === 'string'
          ? requestPayload.body
          : JSON.stringify(requestPayload.body))
      : undefined;

  const headers: Record<string, string> = {
    'x-softprobe-mode': 'REPLAY',
    'x-softprobe-trace-id': inbound.traceId,
    'x-softprobe-cassette-path': file,
  };
  if (body) headers['Content-Type'] = 'application/json';

  const response = await fetch(requestUrl, {
    method,
    headers,
    body,
  });
  return { response, inbound };
}
