import fs from 'node:fs';
import path from 'node:path';

describe('task 2.2 - instrumentation package folders', () => {
  const rootDir = path.resolve(__dirname, '..');
  const packageEntries = [
    'instrumentations/express/index.ts',
    'instrumentations/fastify/index.ts',
    'instrumentations/redis/index.ts',
    'instrumentations/postgres/index.ts',
    'instrumentations/fetch/index.ts',
  ] as const;

  it('exposes package entry modules for supported libraries', async () => {
    for (const relativeEntry of packageEntries) {
      const absoluteEntry = path.join(rootDir, relativeEntry);
      expect(fs.existsSync(absoluteEntry)).toBe(true);
      await expect(import(path.join(rootDir, relativeEntry))).resolves.toBeDefined();
    }
  });
});
