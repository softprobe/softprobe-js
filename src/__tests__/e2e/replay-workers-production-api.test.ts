/**
 * Task 11.5: Replay workers must use only production APIs (init, middleware/context, softprobe.run).
 * No direct setReplayRecordsCache, loadNdjson, or custom matcher injection in worker code.
 */

import fs from 'fs';
import path from 'path';

const HELPERS_DIR = path.join(__dirname, 'helpers');

const REPLAY_WORKER_FILES = [
  'pg-cassette-replay-worker.ts',
  'redis-replay-worker.ts',
  'http-replay-worker.ts',
  'http-strict-replay-worker.ts',
] as const;

const FORBIDDEN_PATTERNS = [
  { pattern: /setReplayRecordsCache/, name: 'setReplayRecordsCache' },
  { pattern: /setGlobalReplayMatcher/, name: 'setGlobalReplayMatcher' },
  {
    pattern: /loadNdjson\s*\(/,
    name: 'loadNdjson (use NdjsonCassette from config instead)',
  },
  {
    pattern: /loadTrace:\s*async\s*\(\s*\)\s*=>\s*loadNdjson/,
    name: 'ad-hoc Cassette with loadNdjson',
  },
];

describe('Task 11.5 - replay workers use only production APIs', () => {
  it('replay worker files do not use setReplayRecordsCache, loadNdjson, or custom matcher injection', () => {
    const violations: string[] = [];
    for (const file of REPLAY_WORKER_FILES) {
      const filePath = path.join(HELPERS_DIR, file);
      if (!fs.existsSync(filePath)) {
        violations.push(`Missing worker file: ${file}`);
        continue;
      }
      const content = fs.readFileSync(filePath, 'utf8');
      for (const { pattern, name } of FORBIDDEN_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(`${file}: must not use ${name}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
