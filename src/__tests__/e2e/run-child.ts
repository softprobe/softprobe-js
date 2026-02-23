/**
 * E2E helper: spawn a Node script with env and return stdout and exit code.
 * Used so capture/replay workloads run in a child process with native require
 * (Jest's module loader breaks require-in-the-middle instrumentations).
 */

import { spawnSync } from 'child_process';

export interface RunChildOptions {
  /** When true, run script with `npx ts-node` so .ts files work. */
  useTsNode?: boolean;
}

/**
 * Spawns a Node script with the given env. Returns stdout, stderr, and exit code.
 * With useTsNode: true, runs `npx ts-node scriptPath` so TypeScript workers work.
 */
export function runChild(
  scriptPath: string,
  env: Record<string, string> = {},
  options: RunChildOptions = {}
): { stdout: string; stderr: string; exitCode: number } {
  const { useTsNode } = options;
  const args = useTsNode
    ? ['ts-node', '--transpile-only', scriptPath]
    : [scriptPath];
  const executable = useTsNode ? 'npx' : process.execPath;
  const result = spawnSync(executable, args, {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
  };
}
