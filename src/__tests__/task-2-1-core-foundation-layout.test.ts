import fs from 'node:fs';
import path from 'node:path';

describe('task 2.1 - core foundation package structure', () => {
  const rootDir = path.resolve(__dirname, '..');

  const requiredEntries = [
    'core/contracts/index.ts',
    'core/runtime/index.ts',
    'core/context/index.ts',
    'core/cassette/index.ts',
    'core/index.ts',
  ] as const;

  it('exposes foundation entry points that compile and import', async () => {
    for (const relativeEntry of requiredEntries) {
      const absoluteEntry = path.join(rootDir, relativeEntry);
      expect(fs.existsSync(absoluteEntry)).toBe(true);
      await expect(import(path.join(rootDir, relativeEntry))).resolves.toBeDefined();
    }
  });

  it('keeps core independent from instrumentation packages', () => {
    const coreDir = path.join(rootDir, 'core');
    const files = collectTsFiles(coreDir);

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source).not.toMatch(/from\s+['\"][^'\"]*instrumentations\//);
      expect(source).not.toMatch(/require\(\s*['\"][^'\"]*instrumentations\//);
    }
  });
});

function collectTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(absolutePath));
      continue;
    }

    if (entry.isFile() && absolutePath.endsWith('.ts')) {
      files.push(absolutePath);
    }
  }

  return files;
}
