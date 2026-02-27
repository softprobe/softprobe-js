import fs from 'node:fs';
import path from 'node:path';

describe('task 2.12 - span helper core migration', () => {
  const srcRoot = path.resolve(__dirname, '..');

  it('moves reusable span helpers to src/core and removes legacy bindings folder runtime files', async () => {
    const coreFiles = [
      path.join(srcRoot, 'core/bindings/http-span.ts'),
      path.join(srcRoot, 'core/bindings/postgres-span.ts'),
      path.join(srcRoot, 'core/bindings/redis-span.ts'),
      path.join(srcRoot, 'core/bindings/test-span.ts'),
    ];

    for (const coreFile of coreFiles) {
      expect(fs.existsSync(coreFile)).toBe(true);
    }

    expect(fs.existsSync(path.join(srcRoot, 'bindings/http-span.ts'))).toBe(false);
    expect(fs.existsSync(path.join(srcRoot, 'bindings/postgres-span.ts'))).toBe(false);
    expect(fs.existsSync(path.join(srcRoot, 'bindings/redis-span.ts'))).toBe(false);
    expect(fs.existsSync(path.join(srcRoot, 'bindings/test-span.ts'))).toBe(false);

    const coreHttp = await import(path.join(srcRoot, 'core/bindings/http-span'));
    const corePostgres = await import(path.join(srcRoot, 'core/bindings/postgres-span'));
    const coreRedis = await import(path.join(srcRoot, 'core/bindings/redis-span'));
    const coreTest = await import(path.join(srcRoot, 'core/bindings/test-span'));

    expect(typeof coreHttp.HttpSpan.fromSpan).toBe('function');
    expect(typeof corePostgres.PostgresSpan.fromSpan).toBe('function');
    expect(typeof coreRedis.RedisSpan.fromSpan).toBe('function');
    expect(typeof coreTest.testSpan).toBe('function');
  });
});
