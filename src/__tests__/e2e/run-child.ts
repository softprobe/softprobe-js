/**
 * E2E helper: spawn a Node script with env and return stdout and exit code.
 * Used so capture/replay workloads run in a child process with native require
 * (Jest's module loader breaks require-in-the-middle instrumentations).
 */

import path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';

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
    cwd: path.resolve(__dirname, '..', '..', '..'),
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
  };
}

/** Project root (repo root when tests run from repo). */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Spawns a long-running Node script (e.g. Express server). Caller must call
 * closeServer(child) when done so pipes are destroyed and Jest can exit.
 */
export function runServer(
  scriptPath: string,
  env: Record<string, string> & { PORT: string },
  options: RunChildOptions = {}
): ChildProcess {
  const { useTsNode = true } = options;
  const args = useTsNode
    ? ['ts-node', '--transpile-only', scriptPath]
    : [scriptPath];
  const executable = useTsNode ? 'npx' : process.execPath;
  return spawn(executable, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: PROJECT_ROOT,
  });
}

/**
 * Kills the child if still running, waits for exit, then destroys stdio streams
 * so Jest does not report open PIPEWRAP handles.
 */
export async function closeServer(child: ChildProcess): Promise<void> {
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise<void>((r) => {
      child.once('exit', r);
      setTimeout(r, 5000);
    });
  }
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/** Poll until GET http://127.0.0.1:port/ returns 2xx or timeout. */
export async function waitForServer(
  port: number,
  timeoutMs = 15000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Server on port ${port} not ready within ${timeoutMs}ms`);
}
