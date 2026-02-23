/**
 * Task 12.4.2: Child worker for HTTP replay E2E.
 * Env: SOFTPROBE_MODE=REPLAY, SOFTPROBE_CASSETTE_PATH, REPLAY_URL
 * Stdout: JSON { status, body }
 */

import '../../../init';
import { loadNdjson } from '../../../store/load-ndjson';
import { softprobe } from '../../../api';
import { SemanticMatcher } from '../../../replay/matcher';
import type { SoftprobeCassetteRecord } from '../../../types/schema';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

/** Builds a minimal span-like for SemanticMatcher (E2E uses flat match by identifier). */
function toSpan(identifier: string, payload: unknown): Record<string, unknown> {
  return {
    attributes: {
      'softprobe.protocol': 'http',
      'softprobe.identifier': identifier,
      'softprobe.response.body': JSON.stringify(payload ?? {}),
    },
  };
}

async function main(): Promise<void> {
  const replayUrl = process.env.REPLAY_URL;
  const cassettePath = process.env.SOFTPROBE_CASSETTE_PATH;
  if (!replayUrl) throw new Error('REPLAY_URL is required');
  if (!cassettePath) throw new Error('SOFTPROBE_CASSETTE_PATH is required');

  const records = await loadNdjson(cassettePath) as SoftprobeCassetteRecord[];
  const spans = records
    .filter(
      (r): r is SoftprobeCassetteRecord & { identifier: string } =>
        r.type === 'outbound' && r.protocol === 'http' && typeof r.identifier === 'string'
    )
    .map((r) => toSpan(r.identifier, r.responsePayload));

  if (spans.length === 0) {
    throw new Error('No outbound HTTP records found in cassette');
  }

  softprobe.setReplayContext({
    traceId: 'http-e2e-replay',
    matcher: new SemanticMatcher(spans as ReadableSpan[]),
  });

  const response = await fetch(replayUrl);
  const body = await response.text();

  process.stdout.write(JSON.stringify({ status: response.status, body }));
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write((err instanceof Error ? err.stack : String(err)) ?? '');
  process.exit(1);
});
