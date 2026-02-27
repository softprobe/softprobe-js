import fs from 'node:fs';
import path from 'node:path';

describe('task 2.11 - retired legacy paths', () => {
  it('has no production imports from retired legacy runtime modules', () => {
    const srcRoot = path.resolve(__dirname, '..');
    const files = collectTsFiles(srcRoot).filter((file) => !file.includes('/__tests__/'));

    const retiredTargets = new Set(
      [
        'capture/express.ts',
        'capture/fastify.ts',
        'capture/redis.ts',
        'capture/postgres.ts',
        'capture/stream-tap.ts',
        'bindings/http-span.ts',
        'bindings/postgres-span.ts',
        'bindings/redis-span.ts',
        'bindings/test-span.ts',
        'replay/express.ts',
        'replay/fastify.ts',
        'replay/redis.ts',
        'replay/postgres.ts',
        'replay/http.ts',
      ].map((p) => normalize(path.join(srcRoot, p)))
    );

    const violations: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const imports = collectImportSpecifiers(source);
      for (const specifier of imports) {
        if (!specifier.startsWith('.')) continue;
        const resolved = resolveToTsPath(file, specifier);
        if (resolved && retiredTargets.has(normalize(resolved))) {
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

function resolveToTsPath(fromFile: string, specifier: string): string | null {
  const candidate = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [candidate, `${candidate}.ts`, path.join(candidate, 'index.ts')];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function normalize(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}
