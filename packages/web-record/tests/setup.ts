if (typeof globalThis.PerformanceObserver === "undefined") {
  Object.defineProperty(globalThis, "PerformanceObserver", {
    configurable: true,
    value: class {
      observe(): void {}
      disconnect(): void {}
      takeRecords(): PerformanceEntryList {
        return [];
      }
    },
  });
}

// Node 25+ defines native sessionStorage on globalThis while Vitest overwrites globalThis.Storage with jsdom's Storage constructor.
if (
  typeof sessionStorage !== "undefined" &&
  typeof Storage !== "undefined" &&
  Object.getPrototypeOf(sessionStorage) !== Storage.prototype
) {
  Object.defineProperty(globalThis, "Storage", {
    configurable: true,
    writable: true,
    value: Object.getPrototypeOf(sessionStorage).constructor,
  });
}
