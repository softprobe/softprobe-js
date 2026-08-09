import { describe, expect, it } from "vitest";
import { BoundedMap, BoundedSet } from "../src/bounded.js";

describe("BoundedSet", () => {
  it("evicts the oldest keys once the cap is exceeded", () => {
    const set = new BoundedSet(3);
    set.add("a");
    set.add("b");
    set.add("c");
    set.add("d");

    expect(set.size).toBe(3);
    expect(set.has("a")).toBe(false);
    expect(set.has("b")).toBe(true);
    expect(set.has("d")).toBe(true);
  });

  it("does not refresh position when a known key is re-added", () => {
    const set = new BoundedSet(2);
    set.add("a");
    set.add("b");
    set.add("a"); // already present — stays the oldest
    set.add("c");

    expect(set.has("a")).toBe(false);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(true);
  });
});

describe("BoundedMap", () => {
  it("evicts the oldest entries once the cap is exceeded", () => {
    const map = new BoundedMap<number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);

    expect(map.size).toBe(2);
    expect(map.get("a")).toBeUndefined();
    expect(map.get("c")).toBe(3);
  });

  it("refreshes position on write so active entries survive", () => {
    const map = new BoundedMap<number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("a", 3); // still in use — moves to the front
    map.set("c", 4);

    expect(map.get("a")).toBe(3);
    expect(map.get("b")).toBeUndefined();
    expect(map.get("c")).toBe(4);
  });
});
