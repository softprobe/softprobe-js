/**
 * Softprobe wrapper utility that avoids shimmer's `__wrapped` metadata.
 * We use Softprobe-owned metadata keys so OpenTelemetry wrapper detection
 * does not treat Softprobe wrappers as foreign wrappers to strip.
 */

export const SOFTPROBE_WRAPPER_MARKER_KEY = '__softprobeWrapped';
export const SOFTPROBE_WRAPPER_ORIGINAL_NAME_KEY = '__softprobeOriginalName';

type AnyFn = (...args: unknown[]) => unknown;
type SoftprobeWrappedFn = AnyFn & {
  __wrapped?: boolean;
  [SOFTPROBE_WRAPPER_MARKER_KEY]?: string;
  [SOFTPROBE_WRAPPER_ORIGINAL_NAME_KEY]?: string;
};

function methodFn(target: Record<string, unknown>, method: string): SoftprobeWrappedFn | undefined {
  const value = target[method];
  if (typeof value !== 'function') return undefined;
  return value as SoftprobeWrappedFn;
}

function markWrapped(fn: SoftprobeWrappedFn, marker: string, originalName: string): void {
  Object.defineProperty(fn, SOFTPROBE_WRAPPER_MARKER_KEY, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: marker,
  });
  Object.defineProperty(fn, SOFTPROBE_WRAPPER_ORIGINAL_NAME_KEY, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: originalName,
  });
}

function preserveName(wrapper: SoftprobeWrappedFn, originalName: string): void {
  if (!originalName) return;
  try {
    Object.defineProperty(wrapper, 'name', {
      configurable: true,
      enumerable: false,
      writable: false,
      value: originalName,
    });
  } catch {
    // best effort only; function name may be non-configurable in some runtimes
  }
}

export function isMethodWrappedWithMarker(
  target: Record<string, unknown>,
  method: string,
  marker: string
): boolean {
  const fn = methodFn(target, method);
  return Boolean(fn && fn[SOFTPROBE_WRAPPER_MARKER_KEY] === marker);
}

/**
 * Wrap target[method] with wrapperFactory(original) and store Softprobe metadata.
 * Idempotent by marker for each method.
 */
export function wrapMethodNoConflict(
  target: Record<string, unknown>,
  method: string,
  marker: string,
  wrapperFactory: (original: AnyFn) => AnyFn
): void {
  const original = methodFn(target, method);
  if (!original) return;
  if (original[SOFTPROBE_WRAPPER_MARKER_KEY] === marker) return;

  const wrapped = wrapperFactory(original) as SoftprobeWrappedFn;
  if (typeof wrapped !== 'function') {
    throw new Error(`wrapMethodNoConflict expected function wrapper for ${String(method)}`);
  }

  preserveName(wrapped, original.name || String(method));
  markWrapped(wrapped, marker, original.name || String(method));

  Object.defineProperty(target, method, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: wrapped,
  });
}
