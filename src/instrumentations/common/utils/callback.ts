/**
 * Settles an asynchronous callback with a value.
 * @param args - The arguments array.
 * @param value - The value to settle with.
 * @returns A promise that resolves with the value.
 */
export async function settleAsync(args: unknown[], value: unknown = undefined) {
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
    if (cb) process.nextTick(() => (cb as (err: Error | null, value: unknown) => void)(null, value));
    return Promise.resolve(value);
  }