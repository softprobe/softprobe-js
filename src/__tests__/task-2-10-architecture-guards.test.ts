import { collectArchitectureViolations, hasForbiddenImport } from '../core/runtime/architecture-guard';
import fs from 'node:fs';
import path from 'node:path';

describe('task 2.10 - architecture guards', () => {
  it('detects forbidden imports via guard helper', () => {
    expect(hasForbiddenImport("import { x } from '../instrumentations/redis'", 'core')).toBe(true);
    expect(hasForbiddenImport("import { y } from '../../core'", 'instrumentation')).toBe(false);
    expect(hasForbiddenImport("import { z } from '../instrumentations/postgres'", 'instrumentation')).toBe(true);
  });

  it('has no architecture violations in repository sources', () => {
    const violations = collectArchitectureViolations();
    expect(violations).toEqual([]);
  });

  it('flags non-shim runtime code placed in legacy capture/replay/bindings folders', () => {
    const fixturePath = path.resolve(__dirname, '../capture/task-1-1-guard-fixture.ts');

    try {
      fs.writeFileSync(
        fixturePath,
        `
        export const fixture = true;
        const runtimeValue = 1;
        export function readRuntimeValue() {
          return runtimeValue;
        }
        `,
        'utf8'
      );

      const violations = collectArchitectureViolations();
      expect(violations).toContain('legacy-file-not-shim: capture/task-1-1-guard-fixture.ts contains non-export runtime code');
    } finally {
      if (fs.existsSync(fixturePath)) {
        fs.unlinkSync(fixturePath);
      }
    }
  });

  it('flags core imports from legacy folders (capture/replay/bindings)', () => {
    const fixturePath = path.resolve(__dirname, '../core/task-1-2-core-legacy-import-fixture.ts');

    try {
      fs.writeFileSync(
        fixturePath,
        `
        import { tapReadableStream } from '../capture/stream-tap';
        export const fixture = typeof tapReadableStream;
        `,
        'utf8'
      );

      const violations = collectArchitectureViolations();
      expect(violations).toContain('core-imports-legacy: core/task-1-2-core-legacy-import-fixture.ts -> ../capture/stream-tap');
    } finally {
      if (fs.existsSync(fixturePath)) {
        fs.unlinkSync(fixturePath);
      }
    }
  });

  it('flags instrumentation package imports from legacy helper folders', () => {
    const fixturePath = path.resolve(__dirname, '../instrumentations/fetch/task-3-2-legacy-import-fixture.ts');

    try {
      fs.writeFileSync(
        fixturePath,
        `
        import { HttpSpan } from '../../bindings/http-span';
        export const fixture = HttpSpan;
        `,
        'utf8'
      );

      const violations = collectArchitectureViolations();
      expect(violations).toContain(
        'instrumentation-imports-legacy-helper: instrumentations/fetch/task-3-2-legacy-import-fixture.ts -> ../../bindings/http-span'
      );
    } finally {
      if (fs.existsSync(fixturePath)) {
        fs.unlinkSync(fixturePath);
      }
    }
  });

  it('enforces shim-only integrity for touched legacy runtime files', () => {
    const shimPath = path.resolve(__dirname, '../bindings/test-span.ts');
    const original = fs.readFileSync(shimPath, 'utf8');

    try {
      fs.writeFileSync(
        shimPath,
        `
        /**
         * Legacy compatibility re-export for test span helper.
         */
        export { testSpan } from '../core/bindings/test-span';
        const shouldNotExistAtRuntime = 1;
        export type { TestSpan } from '../core/bindings/test-span';
        `,
        'utf8'
      );

      const violations = collectArchitectureViolations();
      expect(violations).toContain('legacy-file-not-shim: bindings/test-span.ts contains non-export runtime code');
    } finally {
      fs.writeFileSync(shimPath, original, 'utf8');
    }
  });
});
