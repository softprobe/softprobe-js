import {
  SOFTPROBE_WRAPPER_MARKER_KEY,
  SOFTPROBE_WRAPPER_ORIGINAL_NAME_KEY,
  wrapMethodNoConflict,
} from '../core/runtime/wrap';

describe('wrapMethodNoConflict', () => {
  it('wraps method without setting __wrapped and stores softprobe marker + original name', () => {
    const target = {
      greet() {
        return 'hello';
      },
    };

    wrapMethodNoConflict(
      target,
      'greet',
      'test.greet',
      (original) =>
        function wrapped(this: unknown): string {
          return `${original.call(this)} world`;
        }
    );

    const wrapped = target.greet as unknown as {
      __wrapped?: boolean;
      [SOFTPROBE_WRAPPER_MARKER_KEY]?: string;
      [SOFTPROBE_WRAPPER_ORIGINAL_NAME_KEY]?: string;
    };
    expect(target.greet()).toBe('hello world');
    expect(wrapped.__wrapped).toBeUndefined();
    expect(wrapped[SOFTPROBE_WRAPPER_MARKER_KEY]).toBe('test.greet');
    expect(wrapped[SOFTPROBE_WRAPPER_ORIGINAL_NAME_KEY]).toBe('greet');
  });

  it('is idempotent for the same marker and does not double-wrap', () => {
    const target = {
      count: 0,
      fn() {
        this.count += 1;
        return this.count;
      },
    };

    wrapMethodNoConflict(
      target,
      'fn',
      'test.fn',
      (original) =>
        function wrapped(this: { count: number }): number {
          return original.call(this) as number;
        }
    );
    wrapMethodNoConflict(
      target,
      'fn',
      'test.fn',
      (original) =>
        function wrapped(this: { count: number }): number {
          return original.call(this) as number;
        }
    );

    expect(target.fn()).toBe(1);
    expect(target.fn()).toBe(2);
  });
});
