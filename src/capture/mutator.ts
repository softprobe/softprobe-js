/**
 * Auto-instrumentation mutator: wraps getNodeAutoInstrumentations to inject
 * Softprobe responseHooks per protocol (postgres, undici, redis). Each protocol
 * is implemented in its own module (capture/postgres.ts, undici.ts, redis.ts);
 * this module only applies the wrap and delegates to injectResponseHook.
 * Design §5.2, §5.3.
 */

import shimmer from 'shimmer';
import { injectResponseHook } from './inject';
import {
  PG_INSTRUMENTATION_NAME,
  buildPostgresResponseHook,
} from './postgres';
import {
  UNDICI_INSTRUMENTATION_NAME,
  buildUndiciResponseHook,
} from './undici';
import {
  REDIS_INSTRUMENTATION_NAME,
  buildRedisResponseHook,
} from './redis';

/** Module-like object that exposes getNodeAutoInstrumentations (for real use or tests). */
export interface AutoInstrumentationsModule {
  getNodeAutoInstrumentations: (options?: unknown) => unknown[];
}

/**
 * Wraps getNodeAutoInstrumentations so that the returned config includes our
 * custom responseHook for each protocol. Pass a module object to mutate (e.g. for tests);
 * if omitted, the real @opentelemetry/auto-instrumentations-node module is used.
 */
export function applyAutoInstrumentationMutator(
  target?: AutoInstrumentationsModule
): void {
  const moduleExport =
    target ?? require('@opentelemetry/auto-instrumentations-node');

  shimmer.wrap(
    moduleExport,
    'getNodeAutoInstrumentations',
    ((original: (options?: unknown) => unknown[]) => {
      return function wrappedGetNodeAutoInstrumentations(
        this: AutoInstrumentationsModule,
        options?: unknown
      ) {
        // Real getNodeAutoInstrumentations(inputConfigs) creates instances from config;
        // merge our responseHooks into the input so instances get them (E2E).
        const input =
          options != null && typeof options === 'object' && !Array.isArray(options)
            ? (options as Record<string, unknown>)
            : {};
        const merged: Record<string, unknown> = { ...input };
        merged[PG_INSTRUMENTATION_NAME] = {
          ...((input[PG_INSTRUMENTATION_NAME] as object) ?? {}),
          responseHook: buildPostgresResponseHook(),
        };
        merged[UNDICI_INSTRUMENTATION_NAME] = {
          ...((input[UNDICI_INSTRUMENTATION_NAME] as object) ?? {}),
          responseHook: buildUndiciResponseHook(),
        };
        merged[REDIS_INSTRUMENTATION_NAME] = {
          ...((input[REDIS_INSTRUMENTATION_NAME] as object) ?? {}),
          responseHook: buildRedisResponseHook(),
        };

        const result = original.call(this, merged);
        // Also mutate return value for mocks that return config-like entries (unit tests).
        const arr = Array.isArray(result) ? result : [];
        injectResponseHook(arr, PG_INSTRUMENTATION_NAME, buildPostgresResponseHook());
        injectResponseHook(arr, UNDICI_INSTRUMENTATION_NAME, buildUndiciResponseHook());
        injectResponseHook(arr, REDIS_INSTRUMENTATION_NAME, buildRedisResponseHook());
        return arr;
      };
    }) as (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown
  );
}
