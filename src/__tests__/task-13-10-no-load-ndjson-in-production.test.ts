/**
 * Task 13.10: No standalone loadNdjson or context-routing capture store in production.
 * All read/write goes through Cassette and SoftprobeContext-created cassettes.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..');

const PRODUCTION_PATHS = [
  path.join(SRC, 'init.ts'),
  path.join(SRC, 'api.ts'),
  path.join(SRC, 'capture', 'express.ts'),
  path.join(SRC, 'capture', 'fastify.ts'),
  path.join(SRC, 'capture', 'postgres.ts'),
  path.join(SRC, 'capture', 'redis.ts'),
  path.join(SRC, 'replay', 'store-accessor.ts'),
  path.join(SRC, 'cli', 'diff.ts'),
];

describe('Task 13.10: no load-ndjson or context-routing-capture-store in production', () => {
  it('production files do not import load-ndjson or loadNdjson', () => {
    const violations: string[] = [];
    const loadNdjsonPattern = /from\s+['"].*load-ndjson['"]|require\s*\(\s*['"].*load-ndjson['"]\s*\)/;
    for (const filePath of PRODUCTION_PATHS) {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      if (loadNdjsonPattern.test(content)) {
        violations.push(path.relative(SRC, filePath));
      }
    }
    expect(violations).toEqual([]);
  });

  it('production files do not import context-routing-capture-store', () => {
    const violations: string[] = [];
    const pattern = /from\s+['"].*context-routing-capture-store['"]|require\s*\(\s*['"].*context-routing-capture-store['"]\s*\)/;
    for (const filePath of PRODUCTION_PATHS) {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      if (pattern.test(content)) {
        violations.push(path.relative(SRC, filePath));
      }
    }
    expect(violations).toEqual([]);
  });
});
