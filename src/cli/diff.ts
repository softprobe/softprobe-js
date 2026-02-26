/**
 * Task 21.2.1: softprobe diff CLI — load cassette inbound, send request with coordination headers.
 * Design §3.1: CLI injects x-softprobe-mode, x-softprobe-trace-id, x-softprobe-cassette-path.
 * Sends cassette path as absolute so the server can load it regardless of its cwd.
 * Sends W3C Traceparent so the server's OTel context uses the same trace id as the cassette.
 * Task 13.10: Load via Cassette (getOrCreateCassette) only; no loadNdjson.
 */

import path from 'path';
import { SoftprobeContext } from '../context';
import type { SoftprobeCassetteRecord } from '../types/schema';

/** Builds W3C Traceparent header (version-traceId-spanId-flags) so the server uses the cassette trace. */
function traceparentFromInbound(inbound: SoftprobeCassetteRecord): string {
  const traceId = (inbound.traceId ?? '').padEnd(32, '0').slice(0, 32).toLowerCase();
  const spanId = (inbound.spanId ?? '0000000000000000').padEnd(16, '0').slice(0, 16).toLowerCase();
  return `00-${traceId}-${spanId}-01`;
}

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
  const cassettePath = path.resolve(process.cwd(), file);
  const fs = await import('fs');
  if (!fs.existsSync(cassettePath)) {
    throw new Error(
      `Cassette file not found: ${cassettePath}. Run the diff from the repository root, e.g. bin/softprobe diff examples/basic-app/softprobe-cassettes.ndjson http://localhost:3000`
    );
  }
  const dir = path.dirname(cassettePath);
  const traceId = path.basename(cassettePath, '.ndjson');
  const records = await SoftprobeContext.getOrCreateCassette(dir, traceId).loadTrace();
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
    'x-softprobe-cassette-path': cassettePath,
    traceparent: traceparentFromInbound(inbound),
  };
  if (body) headers['Content-Type'] = 'application/json';

  const response = await fetch(requestUrl, {
    method,
    headers,
    body,
  });
  return { response, inbound };
}
