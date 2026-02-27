import fs from 'node:fs';
import path from 'node:path';

describe('task 2.12 - span helper core migration', () => {
  const srcRoot = path.resolve(__dirname, '..');

  it('moves reusable span helpers to src/core and keeps legacy bindings as re-export shims', async () => {
    const coreFiles = [
      path.join(srcRoot, 'core/bindings/http-span.ts'),
      path.join(srcRoot, 'core/bindings/postgres-span.ts'),
      path.join(srcRoot, 'core/bindings/redis-span.ts'),
      path.join(srcRoot, 'core/bindings/test-span.ts'),
    ];

    for (const coreFile of coreFiles) {
      expect(fs.existsSync(coreFile)).toBe(true);
    }

    const legacyHttp = await import(path.join(srcRoot, 'bindings/http-span'));
    const legacyPostgres = await import(path.join(srcRoot, 'bindings/postgres-span'));
    const legacyRedis = await import(path.join(srcRoot, 'bindings/redis-span'));
    const legacyTest = await import(path.join(srcRoot, 'bindings/test-span'));

    const coreHttp = await import(path.join(srcRoot, 'core/bindings/http-span'));
    const corePostgres = await import(path.join(srcRoot, 'core/bindings/postgres-span'));
    const coreRedis = await import(path.join(srcRoot, 'core/bindings/redis-span'));
    const coreTest = await import(path.join(srcRoot, 'core/bindings/test-span'));

    expect(legacyHttp.HttpSpan).toBe(coreHttp.HttpSpan);
    expect(legacyPostgres.PostgresSpan).toBe(corePostgres.PostgresSpan);
    expect(legacyRedis.RedisSpan).toBe(coreRedis.RedisSpan);
    expect(legacyTest.testSpan).toBe(coreTest.testSpan);
  });
});
