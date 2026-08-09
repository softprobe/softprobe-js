/**
 * Insertion-ordered collections with a hard cap.
 *
 * Used for bookkeeping that has to outlive a single session: dedup keys must
 * survive a scoped `session.idle` (otherwise a late duplicate delivery
 * recreates a span that was already force-ended), but nothing clears them
 * afterwards except process shutdown. A cap keeps them from growing without
 * bound on a long-lived `opencode serve` while preserving the property that
 * matters — recent ids are always remembered.
 */

export class BoundedSet {
  private readonly items = new Set<string>();

  constructor(private readonly cap: number) {}

  get size(): number {
    return this.items.size;
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  /** Insertion order is kept: re-adding a known key does not refresh it. */
  add(key: string): void {
    if (this.items.has(key)) return;
    this.items.add(key);
    while (this.items.size > this.cap) {
      const oldest = this.items.values().next().value;
      if (oldest === undefined) return;
      this.items.delete(oldest);
    }
  }
}

export class BoundedMap<V> {
  private readonly items = new Map<string, V>();

  constructor(private readonly cap: number) {}

  get size(): number {
    return this.items.size;
  }

  get(key: string): V | undefined {
    return this.items.get(key);
  }

  /** Writing a key refreshes its position, so active entries are not evicted. */
  set(key: string, value: V): void {
    this.items.delete(key);
    this.items.set(key, value);
    while (this.items.size > this.cap) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) return;
      this.items.delete(oldest);
    }
  }

  delete(key: string): void {
    this.items.delete(key);
  }
}
