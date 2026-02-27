/**
 * Shared helpers to inject hooks into the instrumentation config array
 * returned by getNodeAutoInstrumentations. Used by mutator to apply each protocol's hook.
 * Design §5.3: keeps injection logic DRY across capture/postgres, undici, redis.
 */

export type InstrumentationEntry = {
  instrumentationName?: string;
  [hookName: string]: unknown;
};

/**
 * Finds the entry in the config array whose instrumentationName matches, and sets
 * the named hook property. Mutates the array in place and returns it.
 */
export function injectHook(
  result: unknown[],
  instrumentationName: string,
  hookName: string,
  hookFn: (...args: unknown[]) => void,
): unknown[] {
  for (const item of result) {
    const entry = item as InstrumentationEntry;
    if (entry.instrumentationName === instrumentationName) {
      entry[hookName] = hookFn;
      break;
    }
  }
  return result;
}

/** Convenience wrapper: injects a responseHook. */
export function injectResponseHook(
  result: unknown[],
  instrumentationName: string,
  responseHook: (span: unknown, result: unknown) => void,
): unknown[] {
  return injectHook(result, instrumentationName, 'responseHook', responseHook);
}
