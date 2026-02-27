import { collectArchitectureViolations, hasForbiddenImport } from '../core/runtime/architecture-guard';

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
});
