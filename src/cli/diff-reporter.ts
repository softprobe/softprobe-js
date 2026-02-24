/**
 * Task 21.3.1: CLI JSON deep-diff reporter.
 * Prints colored diff of recorded vs live response (status + body) to stderr.
 */

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

/** Recorded response from cassette inbound responsePayload. */
export type RecordedResponse = {
  statusCode?: number;
  body?: unknown;
};

/** Live response from fetch. */
export type LiveResponse = {
  status: number;
  body: unknown;
};

/**
 * Parses response body as JSON when possible; otherwise returns raw string.
 */
function parseBody(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * Compares recorded vs live response. If they differ, prints a colored diff to stderr.
 * @returns true when recorded and live match, false when they differ.
 */
export function reportDiff(
  recorded: RecordedResponse,
  live: LiveResponse,
  opts: { write?: (s: string) => void } = {}
): boolean {
  const write = opts.write ?? ((s: string) => process.stderr.write(s));

  const recStatus = recorded.statusCode;
  const recBody = recorded.body;
  const liveBody = typeof live.body === 'string' ? parseBody(live.body) : live.body;

  const statusMatch = recStatus === undefined || recStatus === live.status;
  const bodyMatch = deepEqual(recBody, liveBody);

  if (statusMatch && bodyMatch) return true;

  write('softprobe diff: response mismatch\n\n');

  if (!statusMatch) {
    write(`${DIM}status:${RESET}\n`);
    if (recStatus !== undefined) {
      write(`  ${GREEN}recorded: ${recStatus}${RESET}\n`);
    }
    write(`  ${RED}live:     ${live.status}${RESET}\n\n`);
  }

  if (!bodyMatch) {
    write(`${DIM}body:${RESET}\n`);
    write(`  ${GREEN}recorded: ${formatJson(recBody)}${RESET}\n`);
    write(`  ${RED}live:     ${formatJson(liveBody)}${RESET}\n`);
  }

  return false;
}

function formatJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
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
