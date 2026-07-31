import { describe, expect, it } from "vitest";
import { DEFAULT_REVALIDATE_MS, SeenSet } from "./seen-set";

const T0 = 1_000_000; // arbitrary epoch-ms base for the injected clock

describe("SeenSet: hit / miss within the revalidation window", () => {
  it("a repeat within the TTL is a HIT", () => {
    const seen = new SeenSet();
    seen.set("flag", "run-1", "user", "user-1", "treatment", T0);
    expect(seen.get("flag", "user", "user-1", T0 + 1)?.variant).toBe("treatment");
  });

  it("an entry aged past the TTL is a MISS (forces revalidation against the server)", () => {
    const seen = new SeenSet(10, 60_000);
    seen.set("flag", "run-1", "user", "user-1", "treatment", T0);
    expect(seen.get("flag", "user", "user-1", T0 + 60_000)).toBeUndefined(); // exactly at TTL -> stale
    // The stale entry is dropped so it cannot mask a later resolution.
    expect(seen.size).toBe(0);
  });

  it("distinct flags / targeting keys do not collide", () => {
    const seen = new SeenSet();
    seen.set("flag-a", "run-1", "user", "user-1", "a", T0);
    seen.set("flag-b", "run-1", "user", "user-1", "b", T0);
    seen.set("flag-a", "run-1", "user", "user-2", "c", T0);
    expect(seen.get("flag-a", "user", "user-1", T0)?.variant).toBe("a");
    expect(seen.get("flag-b", "user", "user-1", T0)?.variant).toBe("b");
    expect(seen.get("flag-a", "user", "user-2", T0)?.variant).toBe("c");
  });

  it("distinct idTypes sharing a bare targetingKey do not collide", () => {
    // Entity identity is (idType, targetingKey): "user 42" and "workspace 42"
    // are different Entities and may hold different Variants.
    const seen = new SeenSet();
    seen.set("flag", "run-1", "user", "42", "a", T0);
    seen.set("flag", "run-1", "workspace", "42", "b", T0);
    expect(seen.get("flag", "user", "42", T0)?.variant).toBe("a");
    expect(seen.get("flag", "workspace", "42", T0)?.variant).toBe("b");
    expect(seen.size).toBe(2);
  });

  it("stores a null variant (200 no-match) as a distinct cached entry", () => {
    const seen = new SeenSet();
    seen.set("flag", "run-1", "user", "user-1", null, T0);
    const entry = seen.get("flag", "user", "user-1", T0 + 1);
    expect(entry).toBeDefined();
    expect(entry?.variant).toBeNull();
  });

  it("a re-set under a NEW runId overwrites the entry (Run boundary re-cache)", () => {
    const seen = new SeenSet();
    seen.set("flag", "run-1", "user", "user-1", "a", T0);
    seen.set("flag", "run-2", "user", "user-1", "b", T0 + 100);
    expect(seen.get("flag", "user", "user-1", T0 + 200)?.variant).toBe("b");
    expect(seen.size).toBe(1);
  });
});

describe("SeenSet: LRU eviction", () => {
  it("evicts the least-recently-used entry at capacity", () => {
    const seen = new SeenSet(2);
    seen.set("f", "r", "user", "a", 1, T0);
    seen.set("f", "r", "user", "b", 2, T0);
    // Touch "a" so "b" becomes least-recently-used.
    expect(seen.get("f", "user", "a", T0)?.variant).toBe(1);
    seen.set("f", "r", "user", "c", 3, T0);
    expect(seen.size).toBe(2);
    expect(seen.get("f", "user", "b", T0)).toBeUndefined(); // evicted
    expect(seen.get("f", "user", "a", T0)?.variant).toBe(1);
    expect(seen.get("f", "user", "c", T0)?.variant).toBe(3);
  });

  it("rejects a non-positive maxSize loudly", () => {
    expect(() => new SeenSet(0)).toThrowError(
      expect.objectContaining({ code: "SDK_SEEN_SET_MAX_SIZE_INVALID" }),
    );
  });

  it("rejects a negative ttlMs loudly", () => {
    expect(() => new SeenSet(10, -1)).toThrowError(
      expect.objectContaining({ code: "SDK_SEEN_SET_TTL_INVALID" }),
    );
  });

  it("exposes a sane default revalidation window (~60s)", () => {
    expect(DEFAULT_REVALIDATE_MS).toBe(60_000);
  });
});
