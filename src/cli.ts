#!/usr/bin/env node
/**
 * CLI entry point for softprobe. Usage: softprobe diff <cassette.ndjson> <targetUrl>
 * Task 21.3.1: on mismatch, prints colored diff of recorded vs live and exits 1.
 */

import { runDiff } from './cli/diff';
import { reportDiff } from './cli/diff-reporter';

const args = process.argv.slice(2);
const command = args[0];
const file = args[1];
const target = args[2];

function usage(): void {
  console.error('Usage: softprobe diff <cassette.ndjson> <targetUrl>');
  console.error('  Replays the recorded inbound request to the target with coordination headers.');
}

/** Extracts recorded status and body from cassette inbound (responsePayload or top-level). */
function getRecordedResponse(inbound: { responsePayload?: unknown; statusCode?: number }): {
  statusCode?: number;
  body?: unknown;
} {
  const payload = inbound.responsePayload as { statusCode?: number; status?: number; body?: unknown } | undefined;
  return {
    statusCode: payload?.statusCode ?? payload?.status ?? inbound.statusCode,
    body: payload?.body,
  };
}

async function main(): Promise<number> {
  if (command !== 'diff' || !file || !target) {
    usage();
    return 1;
  }
  try {
    const { response, inbound } = await runDiff(file, target);
    const liveBody = await response.text();
    const recorded = getRecordedResponse(inbound);
    const match = reportDiff(
      recorded,
      { status: response.status, body: liveBody },
      {}
    );
    if (!match) return 1;
    process.stderr.write('softprobe diff: PASS (response matches recording)\n');
    if (liveBody) process.stdout.write(liveBody + (liveBody.endsWith('\n') ? '' : '\n'));
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
