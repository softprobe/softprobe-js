/**
 * Unit tests for settleAsync (instrumentations/common/utils/callback).
 * Ensures callback is invoked when present and return value is correct.
 */

import { settleAsync } from '../instrumentations/common/utils/callback';

describe('settleAsync', () => {
  it('returns a promise that resolves with the value', async () => {
    const value = { ok: true };
    const result = await settleAsync([], value);
    expect(result).toBe(value);
  });

  it('resolves with undefined when value is omitted', async () => {
    const result = await settleAsync([]);
    expect(result).toBeUndefined();
  });

  it('invokes callback with (null, value) on next tick when last arg is a function', async () => {
    const value = 'OK';
    const cb = jest.fn<void, [Error | null, unknown]>();
    const resultPromise = settleAsync([cb], value);

    expect(cb).not.toHaveBeenCalled();
    const result = await resultPromise;
    expect(result).toBe(value);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(null, value);
  });

  it('does not treat non-function last arg as callback', async () => {
    const result = await settleAsync(['not', 'a', 'function'], 42);
    expect(result).toBe(42);
  });

  it('invokes callback with (null, undefined) when value is omitted', async () => {
    const cb = jest.fn<void, [Error | null, unknown]>();
    await settleAsync([cb]);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    expect(cb).toHaveBeenCalledWith(null, undefined);
  });

  it('still returns promise when callback is present', async () => {
    const cb = jest.fn<void, [Error | null, unknown]>();
    const out = await settleAsync([cb], 'resolved');
    expect(out).toBe('resolved');
    await new Promise<void>((resolve) => process.nextTick(resolve));
    expect(cb).toHaveBeenCalledWith(null, 'resolved');
  });
});
