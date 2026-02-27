import fs from 'node:fs';
import path from 'node:path';

describe('task 2.11 - retired legacy paths', () => {
  it('has no production imports from retired legacy runtime modules', () => {
    const srcRoot = path.resolve(__dirname, '..');
    const files = collectTsFiles(srcRoot).filter((file) => !file.includes('/__tests__/'));

    const forbiddenSpecifiers = [
      'capture/express',
      'capture/fastify',
      'capture/redis',
      'capture/postgres',
      'replay/express',
      'replay/fastify',
      'replay/redis',
      'replay/postgres',
      'replay/http',
    ];

    const violations: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const imports = collectImportSpecifiers(source);
      for (const specifier of imports) {
        if (forbiddenSpecifiers.some((token) => specifier.includes(token))) {
          violations.push(`${path.relative(srcRoot, file)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(absolutePath));
    } else if (entry.isFile() && absolutePath.endsWith('.ts')) {
      out.push(absolutePath);
    }
  }
  return out;
}

function collectImportSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const regex = /from\s+['\"]([^'\"]+)['\"]/g;
  for (const match of source.matchAll(regex)) {
    specs.push(match[1]);
  }
  return specs;
}
