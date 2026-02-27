import fs from 'node:fs';
import path from 'node:path';

describe('task 2.13 - identifier core migration', () => {
  const srcRoot = path.resolve(__dirname, '..');

  it('moves identifier helpers to src/core with legacy root shim exports', async () => {
    const coreIdentifierFile = path.join(srcRoot, 'core/identifier.ts');
    expect(fs.existsSync(coreIdentifierFile)).toBe(true);

    const legacyIdentifier = await import(path.join(srcRoot, 'identifier'));
    const coreIdentifier = await import(path.join(srcRoot, 'core/identifier'));

    expect(legacyIdentifier.httpIdentifier).toBe(coreIdentifier.httpIdentifier);
    expect(legacyIdentifier.redisIdentifier).toBe(coreIdentifier.redisIdentifier);
    expect(legacyIdentifier.pgIdentifier).toBe(coreIdentifier.pgIdentifier);
  });
});
