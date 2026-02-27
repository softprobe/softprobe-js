/**
 * Auto-instrumentation mutator: wraps getNodeAutoInstrumentations to inject
 * Softprobe responseHooks per protocol (postgres, redis). HTTP capture/replay
 * is done solely via the MSW interceptor (replay/http.ts), not undici instrumentation.
 * Design §5.2, §5.3.
 */

import shimmer from 'shimmer';
import { injectResponseHook, injectHook } from './inject';
import {
  PG_INSTRUMENTATION_NAME,
  buildPostgresRequestHook,
  buildPostgresResponseHook,
} from '../instrumentations/postgres/capture';
import {
  REDIS_INSTRUMENTATION_NAME,
  buildRedisResponseHook,
} from '../instrumentations/redis/capture';

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
          requestHook: buildPostgresRequestHook(),
          responseHook: buildPostgresResponseHook(),
        };
        merged[REDIS_INSTRUMENTATION_NAME] = {
          ...((input[REDIS_INSTRUMENTATION_NAME] as object) ?? {}),
          responseHook: buildRedisResponseHook(),
        };

        const result = original.call(this, merged);
        // Also mutate return value for mocks that return config-like entries (unit tests).
        const arr = Array.isArray(result) ? result : [];
        injectHook(arr, PG_INSTRUMENTATION_NAME, 'requestHook', buildPostgresRequestHook());
        injectResponseHook(arr, PG_INSTRUMENTATION_NAME, buildPostgresResponseHook());
        injectResponseHook(arr, REDIS_INSTRUMENTATION_NAME, buildRedisResponseHook());
        return arr;
      };
    }) as (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown
  );
}
