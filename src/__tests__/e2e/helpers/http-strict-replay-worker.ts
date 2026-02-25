/**
 * Task 13.1: Child worker for strict-replay E2E.
 * Env: SOFTPROBE_MODE=REPLAY, SOFTPROBE_STRICT_REPLAY=1, SOFTPROBE_CASSETTE_PATH, UNRECORDED_URL
 * Fetches UNRECORDED_URL (not in cassette); expects 500 from interceptor, not passthrough.
 * Stdout: JSON { status, body }
 */

import '../../../init';
import { loadNdjson } from '../../../store/load-ndjson';
import { softprobe } from '../../../api';
import { SemanticMatcher } from '../../../replay/matcher';
import type { SoftprobeCassetteRecord } from '../../../types/schema';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { runSoftprobeScope } from '../../helpers/run-softprobe-scope';

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
  const unrecordedUrl = process.env.UNRECORDED_URL;
  const cassettePath = process.env.SOFTPROBE_CASSETTE_PATH;
  if (!unrecordedUrl) throw new Error('UNRECORDED_URL is required');
  if (!cassettePath) throw new Error('SOFTPROBE_CASSETTE_PATH is required');

  const records = (await loadNdjson(cassettePath)) as SoftprobeCassetteRecord[];
  const spans = records
    .filter(
      (r): r is SoftprobeCassetteRecord & { identifier: string } =>
        r.type === 'outbound' && r.protocol === 'http' && typeof r.identifier === 'string'
    )
    .map((r) => toSpan(r.identifier, r.responsePayload));

  const matcher = new SemanticMatcher(spans as unknown as ReadableSpan[]);
  await runSoftprobeScope(
    { traceId: 'strict-e2e-replay', matcher },
    async () => {
      const response = await fetch(unrecordedUrl);
      const body = await response.text();
      process.stdout.write(JSON.stringify({ status: response.status, body }));
    }
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write((err instanceof Error ? err.stack : String(err)) ?? '');
  process.exit(1);
});
