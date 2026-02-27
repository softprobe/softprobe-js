import fs from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '..', '..');
const INSTRUMENTATIONS_ROOT = path.join(SRC_ROOT, 'instrumentations');
const CORE_ROOT = path.join(SRC_ROOT, 'core');

const LEGACY_SHIM_FILES = [
  path.join(SRC_ROOT, 'capture/express.ts'),
  path.join(SRC_ROOT, 'capture/fastify.ts'),
  path.join(SRC_ROOT, 'capture/postgres.ts'),
  path.join(SRC_ROOT, 'capture/redis.ts'),
  path.join(SRC_ROOT, 'replay/express.ts'),
  path.join(SRC_ROOT, 'replay/fastify.ts'),
  path.join(SRC_ROOT, 'replay/postgres.ts'),
  path.join(SRC_ROOT, 'replay/redis.ts'),
  path.join(SRC_ROOT, 'replay/http.ts'),
];

/**
 * Returns true when source text contains a forbidden instrumentation import for the given scope.
 */
export function hasForbiddenImport(source: string, scope: 'core' | 'instrumentation'): boolean {
  if (scope === 'core') {
    return /from\s+['\"][^'\"]*instrumentations\//.test(source);
  }
  return /from\s+['\"][^'\"]*instrumentations\/(?!common\/)/.test(source);
}

/**
 * Scans repository source layout for architecture violations described by Task 2.10.
 */
export function collectArchitectureViolations(): string[] {
  const violations: string[] = [];

  const coreFiles = collectTsFiles(CORE_ROOT);
  for (const file of coreFiles) {
    const imports = collectImportSpecifiers(fs.readFileSync(file, 'utf8'));
    for (const specifier of imports) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveToTsPath(file, specifier);
      if (resolved && normalized(resolved).includes('/src/instrumentations/')) {
        violations.push(`core-imports-instrumentation: ${relative(file)} -> ${specifier}`);
      }
    }
  }

  const packageDirs = fs
    .readdirSync(INSTRUMENTATIONS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'common')
    .map((entry) => path.join(INSTRUMENTATIONS_ROOT, entry.name));

  for (const packageDir of packageDirs) {
    const packageName = path.basename(packageDir);
    const files = collectTsFiles(packageDir);
    for (const file of files) {
      const imports = collectImportSpecifiers(fs.readFileSync(file, 'utf8'));
      for (const specifier of imports) {
        if (!specifier.startsWith('.')) continue;
        const resolved = resolveToTsPath(file, specifier);
        if (!resolved) continue;
        const normalizedPath = normalized(resolved);
        if (!normalizedPath.includes('/src/instrumentations/')) continue;
        if (normalizedPath.includes('/src/instrumentations/common/')) continue;
        if (normalizedPath.includes(`/src/instrumentations/${packageName}/`)) continue;
        violations.push(`instrumentation-cross-package-import: ${relative(file)} -> ${specifier}`);
      }
    }
  }

  for (const file of LEGACY_SHIM_FILES) {
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('Legacy compatibility re-export')) {
      violations.push(`legacy-file-not-shim: ${relative(file)} missing compatibility marker`);
      continue;
    }

    const nonCommentCode = source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('/**') && !line.startsWith('*') && !line.startsWith('*/'));

    const hasNonExportCode = nonCommentCode.some((line) =>
      /\b(function|class|const|let|var|if|return|new)\b/.test(line)
    );

    if (hasNonExportCode) {
      violations.push(`legacy-file-not-shim: ${relative(file)} contains non-export runtime code`);
    }
  }

  return violations;
}

function collectTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(absolutePath));
      continue;
    }

    if (entry.isFile() && absolutePath.endsWith('.ts') && !absolutePath.includes('/__tests__/')) {
      out.push(absolutePath);
    }
  }

  return out;
}

function collectImportSpecifiers(source: string): string[] {
  const out: string[] = [];
  const regex = /from\s+['\"]([^'\"]+)['\"]/g;

  for (const match of source.matchAll(regex)) {
    out.push(match[1]);
  }

  return out;
}

function resolveToTsPath(fromFile: string, specifier: string): string | null {
  const candidate = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [candidate, `${candidate}.ts`, path.join(candidate, 'index.ts')];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function normalized(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function relative(filePath: string): string {
  return normalized(path.relative(SRC_ROOT, filePath));
}
