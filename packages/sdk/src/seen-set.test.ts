import { describe, expect, it } from "vitest";
import { DEFAULT_REVALIDATE_MS, SeenSet } from "./seen-set";

const T0 = 1_000_000; // arbitrary epoch-ms base for the injected clock

describe("SeenSet: hit / miss within the revalidation window", () => {
  it("a repeat within the TTL is a HIT", () => {
    const seen = new SeenSet();
    seen.set("flag", "run-1", "user-1", "treatment", T0);
    expect(seen.get("flag", "user-1", T0 + 1)).toBe("treatment");
  });

  it("an entry aged past the TTL is a MISS (forces revalidation against the server)", () => {
    const seen = new SeenSet(10, 60_000);
    seen.set("flag", "run-1", "user-1", "treatment", T0);
    expect(seen.get("flag", "user-1", T0 + 60_000)).toBeUndefined(); // exactly at TTL -> stale
    // The stale entry is dropped so it cannot mask a later resolution.
    expect(seen.size).toBe(0);
  });

  it("distinct flags / targeting keys do not collide", () => {
    const seen = new SeenSet();
    seen.set("flag-a", "run-1", "user-1", "a", T0);
    seen.set("flag-b", "run-1", "user-1", "b", T0);
    seen.set("flag-a", "run-1", "user-2", "c", T0);
    expect(seen.get("flag-a", "user-1", T0)).toBe("a");
    expect(seen.get("flag-b", "user-1", T0)).toBe("b");
    expect(seen.get("flag-a", "user-2", T0)).toBe("c");
  });

  it("a re-set under a NEW runId overwrites the entry (Run boundary re-cache)", () => {
    const seen = new SeenSet();
    seen.set("flag", "run-1", "user-1", "a", T0);
    seen.set("flag", "run-2", "user-1", "b", T0 + 100);
    expect(seen.get("flag", "user-1", T0 + 200)).toBe("b");
    expect(seen.size).toBe(1);
  });
});

describe("SeenSet: LRU eviction", () => {
  it("evicts the least-recently-used entry at capacity", () => {
    const seen = new SeenSet(2);
    seen.set("f", "r", "a", 1, T0);
    seen.set("f", "r", "b", 2, T0);
    // Touch "a" so "b" becomes least-recently-used.
    expect(seen.get("f", "a", T0)).toBe(1);
    seen.set("f", "r", "c", 3, T0);
    expect(seen.size).toBe(2);
    expect(seen.get("f", "b", T0)).toBeUndefined(); // evicted
    expect(seen.get("f", "a", T0)).toBe(1);
    expect(seen.get("f", "c", T0)).toBe(3);
  });

  it("rejects a non-positive maxSize loudly", () => {
    expect(() => new SeenSet(0)).toThrow(/maxSize/);
  });

  it("rejects a negative ttlMs loudly", () => {
    expect(() => new SeenSet(10, -1)).toThrow(/ttlMs/);
  });

  it("exposes a sane default revalidation window (~60s)", () => {
    expect(DEFAULT_REVALIDATE_MS).toBe(60_000);
  });
});
