import fs from 'node:fs';
import path from 'node:path';

describe('task 2.3 - instrumentation common helpers', () => {
  const sourceRoot = path.resolve(__dirname, '..');

  it('provides shared common helpers and consumes them in at least two packages', () => {
    const helperFile = path.join(sourceRoot, 'instrumentations/common/http/context-headers.ts');
    expect(fs.existsSync(helperFile)).toBe(true);

    const packageRoots = [
      path.join(sourceRoot, 'instrumentations/express'),
      path.join(sourceRoot, 'instrumentations/fastify'),
      path.join(sourceRoot, 'instrumentations/redis'),
      path.join(sourceRoot, 'instrumentations/postgres'),
      path.join(sourceRoot, 'instrumentations/fetch'),
    ];

    const imports = packageRoots
      .flatMap((dir) => collectTsFiles(dir))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .filter((source) => source.includes('instrumentations/common/http/context-headers'));

    expect(imports.length).toBeGreaterThanOrEqual(2);
  });
});

function collectTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(absolutePath));
    } else if (entry.isFile() && absolutePath.endsWith('.ts')) {
      files.push(absolutePath);
    }
  }

  return files;
}
