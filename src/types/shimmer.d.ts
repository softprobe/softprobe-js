declare module 'shimmer' {
  function wrap<T extends object>(
    target: T,
    method: keyof T,
    wrapper: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown
  ): void;
}
