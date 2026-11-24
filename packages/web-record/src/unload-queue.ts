const DEFAULT_MAX_QUEUE_BYTES = 512 * 1024;
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

type QueuedOtlpEntry = {
  bytesBase64: string;
  byteLength: number;
  createdAtMs: number;
};

/**
 * Persists serialized OTLP payloads in `sessionStorage` when an unload export
 * exceeds the browser's `keepalive` budget, then drains them on the next
 * same-origin page load.
 */
export class UnloadSpillQueue {
  private draining: Promise<number> | null = null;

  constructor(
    private readonly storageKey: string,
    private readonly maxQueueBytes = DEFAULT_MAX_QUEUE_BYTES,
    private readonly maxAgeMs = DEFAULT_MAX_AGE_MS,
  ) {}

  enqueueSync(bytes: Uint8Array): boolean {
    if (bytes.byteLength === 0 || bytes.byteLength > this.maxQueueBytes) {
      return false;
    }
    const storage = getSessionStorage();
    if (!storage) return false;

    const now = Date.now();
    const entries = this.readEntries(storage, now);
    let totalBytes = entries.reduce((sum, entry) => sum + entry.byteLength, 0);

    while (entries.length > 0 && totalBytes + bytes.byteLength > this.maxQueueBytes) {
      const evicted = entries.shift()!;
      totalBytes -= evicted.byteLength;
    }

    entries.push({
      bytesBase64: uint8ArrayToBase64(bytes),
      byteLength: bytes.byteLength,
      createdAtMs: now,
    });

    return this.writeEntriesWithEviction(storage, entries);
  }

  drain(send: (bytes: Uint8Array) => Promise<boolean>): Promise<number> {
    if (this.draining) return this.draining;
    const run = this.drainInternal(send).finally(() => {
      if (this.draining === run) this.draining = null;
    });
    this.draining = run;
    return run;
  }

  size(): number {
    const storage = getSessionStorage();
    if (!storage) return 0;
    return this.readEntries(storage, Date.now()).length;
  }

  private async drainInternal(
    send: (bytes: Uint8Array) => Promise<boolean>,
  ): Promise<number> {
    const storage = getSessionStorage();
    if (!storage) return 0;

    const entries = this.readEntries(storage, Date.now());
    if (entries.length === 0) return 0;

    try {
      storage.removeItem(this.storageKey);
    } catch {
      return 0;
    }

    let sent = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const payload = base64ToUint8Array(entry.bytesBase64);
      if (!payload) continue;

      let ok = false;
      try {
        ok = await send(payload);
      } catch {
        ok = false;
      }
      if (!ok) {
        for (let rest = index; rest < entries.length; rest += 1) {
          const remaining = base64ToUint8Array(entries[rest]!.bytesBase64);
          if (remaining) this.enqueueSync(remaining);
        }
        break;
      }
      sent += 1;
    }
    return sent;
  }

  private readEntries(storage: Storage, now: number): QueuedOtlpEntry[] {
    try {
      const raw = storage.getItem(this.storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item): item is QueuedOtlpEntry =>
          item !== null &&
          typeof item === "object" &&
          typeof item.bytesBase64 === "string" &&
          typeof item.byteLength === "number" &&
          typeof item.createdAtMs === "number" &&
          item.byteLength > 0 &&
          now - item.createdAtMs <= this.maxAgeMs,
      );
    } catch {
      return [];
    }
  }

  private writeEntriesWithEviction(
    storage: Storage,
    entries: QueuedOtlpEntry[],
  ): boolean {
    const working = [...entries];
    while (working.length > 0) {
      try {
        storage.setItem(this.storageKey, JSON.stringify(working));
        return true;
      } catch {
        // Evict oldest entry on QuotaExceededError and retry.
        if (working.length === 1) return false;
        working.shift();
      }
    }
    return false;
  }
}

function getSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}
