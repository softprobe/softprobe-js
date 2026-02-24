/**
 * Helper for example tests: spawn a Node script with env.
 * Keeps the example self-contained (no import from softprobe src).
 */

import path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';

export function runChild(
  scriptPath: string,
  env: Record<string, string> = {},
  useTsNode = false
): { stdout: string; stderr: string; exitCode: number } {
  const args = useTsNode ? ['ts-node', '--transpile-only', scriptPath] : [scriptPath];
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

export interface RunServerOptions {
  useTsNode?: boolean;
  /** Preload this module first (e.g. instrumentation.ts). Use node -r. */
  require?: string;
}

/** Spawn the server script; caller must kill the returned child when done. */
export function runServer(
  scriptPath: string,
  env: Record<string, string> & { PORT: string },
  options: RunServerOptions | boolean = true
): ChildProcess {
  const opts = typeof options === 'boolean' ? { useTsNode: options } : options;
  const useTsNode = opts.useTsNode !== false;
  const requirePath = opts.require;

  const args: string[] = [];
  if (useTsNode && requirePath) {
    const exampleDir = path.dirname(scriptPath);
    args.push('ts-node', '--transpile-only', '-r', './instrumentation.ts', path.basename(scriptPath));
    return spawn('npx', args, {
      cwd: exampleDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  if (useTsNode) {
    args.push('ts-node', '--transpile-only', scriptPath);
    return spawn('npx', args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return spawn(process.execPath, [scriptPath], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Poll until GET http://localhost:port{path} returns 200 or timeout. Use path='/ping' for replay so / is not hit without traceparent. */
export async function waitForServer(port: number, timeoutMs = 15000, path = '/'): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      if (res.ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Server on port ${port} not ready within ${timeoutMs}ms`);
}

/** Kill child and destroy stdio so Jest can exit. Call closeServer(child) when done. */
export async function closeServer(child: ChildProcess): Promise<void> {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.kill();
}
