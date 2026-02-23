/**
 * Task 12.4.1: Child worker for HTTP NDJSON cassette capture E2E.
 * Env: SOFTPROBE_MODE=CAPTURE, SOFTPROBE_CASSETTE_PATH
 * Stdout: JSON { url, status, body }
 */

import '../../../init';
import { buildUndiciResponseHook } from '../../../capture/undici';
import { getCaptureStore } from '../../../capture/store-accessor';

async function main(): Promise<void> {
  const url = 'http://offline.softprobe.local/health';
  const statusCode = 200;
  const body = 'http-e2e-ok';

  const attrs: Record<string, unknown> = {};
  const span = {
    name: 'GET',
    parentSpanId: undefined as string | undefined,
    spanContext: () => ({ traceId: 'http-e2e-trace', spanId: 'http-e2e-span' }),
    setAttribute: (k: string, v: unknown) => {
      attrs[k] = v;
    },
  };

  const hook = buildUndiciResponseHook();
  hook(span, {
    request: { method: 'GET', url },
    response: { statusCode, body },
  });

  const store = getCaptureStore();
  if (!store) throw new Error('Capture store is not initialized');
  await store.flushOnExit();

  process.stdout.write(JSON.stringify({ url, status: statusCode, body }));
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write((err instanceof Error ? err.stack : String(err)) ?? '');
  process.exit(1);
});
