/**
 * Task 13.6: Only SoftprobeContext (or its designated factory) creates cassette instances.
 * No new NdjsonCassette in init, middleware, request-storage, or replay helpers.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..');
const FORBIDDEN_NdjsonCassette = [
  path.join(SRC, 'init.ts'),
  path.join(SRC, 'capture', 'express.ts'),
  path.join(SRC, 'capture', 'fastify.ts'),
  path.join(SRC, 'core', 'cassette', 'request-storage.ts'),
];
const REPLAY_HELPERS_DIR = path.join(__dirname, 'e2e', 'helpers');

describe('Task 13.6: only SoftprobeContext creates cassette instances', () => {
  it('forbidden production files do not instantiate NdjsonCassette', () => {
    const violations: string[] = [];
    const pattern = /new\s+NdjsonCassette\s*\(/;
    for (const filePath of FORBIDDEN_NdjsonCassette) {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      if (pattern.test(content)) {
        violations.push(path.relative(SRC, filePath));
      }
    }
    expect(violations).toEqual([]);
  });

  it('replay helper workers do not instantiate NdjsonCassette', () => {
    const replayWorkers = [
      'pg-cassette-replay-worker.ts',
      'redis-replay-worker.ts',
      'http-replay-worker.ts',
      'http-strict-replay-worker.ts',
    ];
    const pattern = /new\s+NdjsonCassette\s*\(/;
    const violations: string[] = [];
    for (const name of replayWorkers) {
      const filePath = path.join(REPLAY_HELPERS_DIR, name);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      if (pattern.test(content)) {
        violations.push(name);
      }
    }
    expect(violations).toEqual([]);
  });
});
