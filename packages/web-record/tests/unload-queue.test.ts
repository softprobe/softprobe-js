import { afterEach, describe, expect, it, vi } from "vitest";
import { UnloadSpillQueue } from "../src/unload-queue.js";

const KEY = "_sp_unload_queue:test";

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("UnloadSpillQueue", () => {
  it("persists payloads synchronously in sessionStorage and drains them in FIFO order", async () => {
    const queue = new UnloadSpillQueue(KEY);
    const first = new Uint8Array([1, 2, 3, 4]);
    const second = new Uint8Array([5, 6, 7]);

    expect(queue.enqueueSync(first)).toBe(true);
    expect(queue.enqueueSync(second)).toBe(true);
    expect(queue.size()).toBe(2);

    const received: Uint8Array[] = [];
    const sent = await queue.drain(async (bytes) => {
      received.push(bytes);
      return true;
    });

    expect(sent).toBe(2);
    expect(received).toEqual([first, second]);
    expect(queue.size()).toBe(0);
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("evicts oldest entries when total buffered bytes exceed maxQueueBytes", async () => {
    const queue = new UnloadSpillQueue(KEY, 10);
    expect(queue.enqueueSync(new Uint8Array([1, 1, 1, 1, 1, 1]))).toBe(true);
    expect(queue.enqueueSync(new Uint8Array([2, 2, 2, 2, 2, 2]))).toBe(true);

    expect(queue.size()).toBe(1);
    const received: Uint8Array[] = [];
    await queue.drain(async (bytes) => {
      received.push(bytes);
      return true;
    });
    expect(received).toEqual([new Uint8Array([2, 2, 2, 2, 2, 2])]);
  });

  it("drops expired entries and re-queues unsent entries when send fails", async () => {
    vi.useFakeTimers();
    try {
      const queue = new UnloadSpillQueue(KEY, 1024, 1000);
      queue.enqueueSync(new Uint8Array([9, 9]));
      vi.advanceTimersByTime(1500);
      queue.enqueueSync(new Uint8Array([1, 2]));
      queue.enqueueSync(new Uint8Array([3, 4]));

      const attempts: number[] = [];
      const sent = await queue.drain(async (bytes) => {
        attempts.push(bytes[0]!);
        return bytes[0] === 1;
      });

      expect(sent).toBe(1);
      expect(attempts).toEqual([1, 3]);
      expect(queue.size()).toBe(1);

      const retried: Uint8Array[] = [];
      const retrySent = await queue.drain(async (bytes) => {
        retried.push(bytes);
        return true;
      });
      expect(retrySent).toBe(1);
      expect(retried).toEqual([new Uint8Array([3, 4])]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts oldest entries on QuotaExceededError without throwing", () => {
    const queue = new UnloadSpillQueue(KEY);
    expect(queue.enqueueSync(new Uint8Array([1, 2, 3]))).toBe(true);

    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    setItemSpy.mockImplementationOnce(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    expect(queue.enqueueSync(new Uint8Array([4, 5, 6]))).toBe(true);
    expect(queue.size()).toBe(1);
  });
});
