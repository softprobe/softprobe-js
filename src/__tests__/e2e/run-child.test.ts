/**
 * Task 12.1.1: run-child helper — spawn node scripts with env; returns stdout and exit code.
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
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

  it('throws when legacy softprobe env is provided without explicit config path', () => {
    expect(() =>
      runChild(FIXTURE_ECHO, { SOFTPROBE_MODE: 'CAPTURE', SOFTPROBE_CASSETTE_PATH: '/tmp/a.ndjson' })
    ).toThrow('SOFTPROBE_CONFIG_PATH is required for E2E workers');
  });

  it('passes when explicit SOFTPROBE_CONFIG_PATH is provided', () => {
    const configPath = path.join(
      os.tmpdir(),
      `softprobe-run-child-test-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`
    );
    fs.writeFileSync(configPath, 'mode: PASSTHROUGH\n', 'utf8');
    try {
      const result = runChild(FIXTURE_ECHO, { SOFTPROBE_CONFIG_PATH: configPath, RUN_CHILD_ECHO: 'ok' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('ok');
    } finally {
      if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    }
  });
});
