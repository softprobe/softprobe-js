/**
 * Proof: OTel context propagates to the MSW request listener when run() uses
 * context.with(ctx, async () => await fn()).
 *
 * Key constraint: a single BatchInterceptor must be applied only once (applying
 * a second FetchInterceptor reuses the first instance and only proxies future .on()
 * calls — listeners registered before apply() are on the wrong emitter and never fire).
 * This script applies the interceptor exactly once, then confirms both caller and
 * listener share the same executionAsyncId and the listener sees SOFTPROBE_CONTEXT_KEY.
 *
 * Run: npx ts-node --transpile-only scripts/experiment-otel-phase3-only.ts
 * Expected output: "listener sees SOFTPROBE key? true", same asyncId for caller and listener.
 */

import { executionAsyncId } from 'async_hooks';
import { context } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { BatchInterceptor } from '@mswjs/interceptors';
import { FetchInterceptor } from '@mswjs/interceptors/fetch';
import { SOFTPROBE_CONTEXT_KEY } from '../src/context';

const TEST_KEY = SOFTPROBE_CONTEXT_KEY;
const TEST_VALUE = { mode: 'CAPTURE' as const, traceId: 'experiment-trace' };

async function main(): Promise<void> {
  const sdk = new NodeSDK({ instrumentations: [getNodeAutoInstrumentations()] });
  sdk.start();

  const ctxWithSoftprobe = context.active().setValue(TEST_KEY, TEST_VALUE);

  const interceptor = new BatchInterceptor({
    name: 'experiment',
    interceptors: [new FetchInterceptor()],
  });

  let listenerAsyncId: number | undefined;
  let callerAsyncId: number | undefined;
  let listenerHasKey = false;

  interceptor.on('request', ({ controller }) => {
    const activeCtx = context.active();
    listenerHasKey = activeCtx.getValue(TEST_KEY) !== undefined;
    listenerAsyncId = executionAsyncId();
    controller.respondWith(new Response(JSON.stringify({ ok: true })));
  });

  interceptor.apply();

  await context.with(ctxWithSoftprobe, async () => {
    callerAsyncId = executionAsyncId();
    await fetch('https://example.com/');
  });

  console.log('callerAsyncId', callerAsyncId);
  console.log('listenerAsyncId', listenerAsyncId);
  console.log('same async id?', callerAsyncId === listenerAsyncId);
  console.log('listener sees SOFTPROBE key?', listenerHasKey);
  await sdk.shutdown();
  process.exit(0);
}

main();
