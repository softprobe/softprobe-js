import fs from 'node:fs';
import path from 'node:path';

describe('task 2.13 - identifier core migration', () => {
  const srcRoot = path.resolve(__dirname, '..');

  it('moves identifier helpers to src/core and removes legacy root identifier shim', async () => {
    const coreIdentifierFile = path.join(srcRoot, 'core/identifier.ts');
    expect(fs.existsSync(coreIdentifierFile)).toBe(true);
    expect(fs.existsSync(path.join(srcRoot, 'identifier.ts'))).toBe(false);

    const coreIdentifier = await import(path.join(srcRoot, 'core/identifier'));

    expect(coreIdentifier.httpIdentifier('get', '/users')).toBe('GET /users');
    expect(coreIdentifier.redisIdentifier('set', ['k', 'v'])).toBe('SET k v');
    expect(coreIdentifier.pgIdentifier('SELECT 1')).toBe('SELECT 1');
  });
});
