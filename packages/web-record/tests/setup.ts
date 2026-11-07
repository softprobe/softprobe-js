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
