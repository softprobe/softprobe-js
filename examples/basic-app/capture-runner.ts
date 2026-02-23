/**
 * Runs the example app once in CAPTURE mode, triggers one request, then /exit
 * so the cassette is flushed. Use: npm run example:capture (from repo root).
 *
 * Env (defaults): SOFTPROBE_MODE=CAPTURE, SOFTPROBE_CASSETTE_PATH=./softprobe-cassettes.ndjson, PORT=3000.
 */

import { spawn } from 'child_process';
import path from 'path';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function waitForServer(timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`);
      if (res.ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Server on port ${PORT} not ready within ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  const exampleDir = path.resolve(__dirname);
  const runTs = path.join(exampleDir, 'run.ts');
  const instrumentation = path.join(exampleDir, 'instrumentation.ts');

  const child = spawn(
    'npx',
    ['ts-node', '--transpile-only', '-r', './instrumentation.ts', path.basename(runTs)],
    {
      cwd: exampleDir,
      env: {
        ...process.env,
        SOFTPROBE_MODE: 'CAPTURE',
        SOFTPROBE_CASSETTE_PATH: process.env.SOFTPROBE_CASSETTE_PATH ?? './softprobe-cassettes.ndjson',
        PORT: String(PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk);
  });

  try {
    await waitForServer();
    await fetch(`http://127.0.0.1:${PORT}/`);
    await fetch(`http://127.0.0.1:${PORT}/exit`);
  } catch (err) {
    child.kill();
    console.error(err);
    process.exit(1);
  }

  await new Promise<void>((resolve, reject) => {
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Child exited with code ${code}. ${stderr}`));
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
