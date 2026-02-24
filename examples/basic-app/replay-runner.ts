/**
 * Runs the example app once in REPLAY mode against a cassette (no live Postgres/Redis/HTTP).
 * Use: npm run example:replay (from repo root).
 *
 * Env: SOFTPROBE_MODE=REPLAY, SOFTPROBE_STRICT_REPLAY=1, SOFTPROBE_CASSETTE_PATH,
 *      SOFTPROBE_TRACE_ID (optional; for test or when cassette has one trace), PORT.
 * Stdout: single line JSON of GET / response body.
 */

import { spawn } from 'child_process';
import path from 'path';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

/** Build W3C traceparent (trace-id must be 32 hex chars, no dashes). */
function traceparentHeader(traceId: string): string {
  const normalized = String(traceId).trim().toLowerCase().replace(/-/g, '').padStart(32, '0').slice(-32);
  return `00-${normalized}-0000000000000001-01`;
}

async function waitForServer(timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/ping`);
      if (res.ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Server on port ${PORT} not ready within ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  const traceId = process.env.SOFTPROBE_TRACE_ID;
  if (!traceId) {
    console.error('SOFTPROBE_TRACE_ID is required for replay (traceId from cassette)');
    process.exit(1);
  }

  const exampleDir = path.resolve(__dirname);
  const runTs = path.join(exampleDir, 'run.ts');

  const child = spawn(
    'npx',
    ['ts-node', '--transpile-only', '-r', './instrumentation.ts', path.basename(runTs)],
    {
      cwd: exampleDir,
      env: {
        ...process.env,
        SOFTPROBE_MODE: 'REPLAY',
        SOFTPROBE_STRICT_REPLAY: '1',
        SOFTPROBE_CASSETTE_PATH:
          process.env.SOFTPROBE_CASSETTE_PATH ?? './softprobe-cassettes.ndjson',
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
    process.stderr.write(chunk);
  });

  const traceparent = traceparentHeader(traceId);
  try {
    await waitForServer(15000);
    const res = await fetch(`http://127.0.0.1:${PORT}/`, {
      headers: { traceparent },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GET / failed: ${res.status} ${text}`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    process.stdout.write(JSON.stringify(json) + '\n');
    await fetch(`http://127.0.0.1:${PORT}/exit`).catch(() => {});
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
