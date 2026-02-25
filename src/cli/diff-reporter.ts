/**
 * Diff reporter: compares recorded response (from cassette) vs live response (from server).
 * Used by `softprobe diff`. On match returns true; on mismatch prints a colored diff
 * (status and body) to stderr and returns false. So the CLI can show PASS/FAIL and
 * on failure show what differed.
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
  const recBody = typeof recorded.body === 'string' ? parseBody(recorded.body) : recorded.body;
  const liveBody = typeof live.body === 'string' ? parseBody(live.body) : live.body;

  const statusMatch = recStatus === undefined || recStatus === live.status;
  const bodyMatch = deepEqual(recBody, liveBody);

  if (statusMatch && bodyMatch) return true;

  write('softprobe diff: FAIL — response differs from recording\n\n');

  if (!statusMatch) {
    write(`${DIM}status:${RESET}\n`);
    if (recStatus !== undefined) {
      write(`  ${GREEN}recorded: ${recStatus}${RESET}\n`);
    }
    write(`  ${RED}live:     ${live.status}${RESET}\n\n`);
  }

  if (!bodyMatch) {
    const diffs = collectDiffs(recBody, liveBody, '');
    write(`${DIM}body (only differences):${RESET}\n`);
    for (const { path, recorded: r, live: l } of diffs) {
      write(`  ${DIM}${path}:${RESET}\n`);
      write(`    ${GREEN}recorded: ${formatValue(r)}${RESET}\n`);
      write(`    ${RED}live:     ${formatValue(l)}${RESET}\n`);
    }
  }

  return false;
}

/** Collect paths where recorded and live differ; only report leaf differences. */
function collectDiffs(
  recorded: unknown,
  live: unknown,
  path: string
): Array<{ path: string; recorded: unknown; live: unknown }> {
  if (recorded === live) return [];
  if (recorded === null || live === null || typeof recorded !== 'object' || typeof live !== 'object') {
    return [{ path: path || '(root)', recorded, live }];
  }
  const rec = recorded as Record<string, unknown>;
  const liv = live as Record<string, unknown>;
  const keys = new Set([...Object.keys(rec), ...Object.keys(liv)]);
  const out: Array<{ path: string; recorded: unknown; live: unknown }> = [];
  for (const k of [...keys].sort()) {
    const p = path ? `${path}.${k}` : k;
    const rv = rec[k];
    const lv = liv[k];
    if (rv === lv) continue;
    if (Array.isArray(rv) && Array.isArray(lv)) {
      if (!deepEqual(rv, lv)) out.push({ path: p, recorded: rv, live: lv });
      continue;
    }
    if (
      rv !== null &&
      lv !== null &&
      typeof rv === 'object' &&
      typeof lv === 'object' &&
      !Array.isArray(rv) &&
      !Array.isArray(lv)
    ) {
      out.push(...collectDiffs(rv, lv, p));
    } else {
      out.push({ path: p, recorded: rv, live: lv });
    }
  }
  return out;
}

function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string' && value.length > 80) return JSON.stringify(value.slice(0, 77) + '...');
  try {
    const s = JSON.stringify(value);
    return s.length > 80 ? s.slice(0, 77) + '...' : s;
  } catch {
    return String(value);
  }
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
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
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
