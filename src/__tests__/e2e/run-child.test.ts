/**
 * Task 12.1.1: run-child helper — spawn node scripts with env; returns stdout and exit code.
 */

import path from 'path';
import { runChild } from './run-child';

const FIXTURE_ECHO = path.join(__dirname, 'fixtures', 'run-child-echo.js');

describe('runChild (Task 12.1.1)', () => {
  it('returns stdout and exit code from child script', () => {
    const result = runChild(FIXTURE_ECHO, {});

    expect(result.stdout).toBeDefined();
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
  });

  it('passes env to child and returns child stdout', () => {
    const result = runChild(FIXTURE_ECHO, { RUN_CHILD_ECHO: 'foo' });

    expect(result.stdout.trim()).toBe('foo');
    expect(result.exitCode).toBe(0);
  });

  it('returns non-zero exit code when child exits with code', () => {
    const result = runChild(FIXTURE_ECHO, { EXIT_CODE: '1' });

    expect(result.exitCode).toBe(1);
  });
});
