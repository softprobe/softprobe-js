/**
 * Shared helper to inject a responseHook into the instrumentation config array
 * returned by getNodeAutoInstrumentations. Used by mutator to apply each protocol's hook.
 * Design §5.3: keeps injection logic DRY across capture/postgres, undici, redis.
 */

export type InstrumentationEntry = {
  instrumentationName?: string;
  responseHook?: (span: unknown, result: unknown) => void;
};

/**
 * Finds the entry in the config array whose instrumentationName matches, and sets
 * its responseHook. Mutates the array in place and returns it.
 */
export function injectResponseHook(
  result: unknown[],
  instrumentationName: string,
  responseHook: (span: unknown, result: unknown) => void
): unknown[] {
  for (const item of result) {
    const entry = item as InstrumentationEntry;
    if (entry.instrumentationName === instrumentationName) {
      entry.responseHook = responseHook;
      break;
    }
  }
  return result;
}
