import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVALIDATE_MS,
  DEFAULT_VALUES_PER_ENTRY,
  fingerprintAttributes,
  SeenSet,
} from "./seen-set";

const T0 = 1_000_000; // arbitrary epoch-ms base for the injected clock
const EMPTY = {};

/** A resolution whose Variant value and arm name are the same string. */
function arm(name: string) {
  return { variant: name, variantName: name };
}

const TREATMENT = arm("treatment");

describe("SeenSet: hit / miss within the revalidation window", () => {
  it("a repeat within the TTL is a HIT", () => {
    const seen = new SeenSet();
    seen.set("flag", "run-1", "user", "user-1", EMPTY, TREATMENT, T0);
    const lookup = seen.get("flag", "user", "user-1", EMPTY, T0 + 1);
    expect(lookup.kind).toBe("hit");
    if (lookup.kind === "hit") {
      expect(lookup.entry.variant).toBe("treatment");
    }
  });

  it("an entry aged past the TTL is a MISS (forces revalidation against the server)", () => {
    const seen = new SeenSet(10, 60_000);
    seen.set("flag", "run-1", "user", "user-1", EMPTY, TREATMENT, T0);
    expect(seen.get("flag", "user", "user-1", EMPTY, T0 + 60_000).kind).toBe("miss");
    // The stale entry is dropped so it cannot mask a later resolution.
    expect(seen.size).toBe(0);
  });

  it("distinct flags / targeting keys do not collide", () => {
    const seen = new SeenSet();
    seen.set("flag-a", "run-1", "user", "user-1", EMPTY, arm("a"), T0);
    seen.set("flag-b", "run-1", "user", "user-1", EMPTY, arm("b"), T0);
    seen.set("flag-a", "run-1", "user", "user-2", EMPTY, arm("c"), T0);
    const a = seen.get("flag-a", "user", "user-1", EMPTY, T0);
    const b = seen.get("flag-b", "user", "user-1", EMPTY, T0);
    const c = seen.get("flag-a", "user", "user-2", EMPTY, T0);
    expect(a.kind === "hit" && a.entry.variant).toBe("a");
    expect(b.kind === "hit" && b.entry.variant).toBe("b");
    expect(c.kind === "hit" && c.entry.variant).toBe("c");
  });

  it("distinct idTypes sharing a bare targetingKey do not collide", () => {
    // Entity identity is (idType, targetingKey): "user 42" and "workspace 42"
    // are different Entities and may hold different Variants.
    const seen = new SeenSet();
    seen.set("flag", "run-1", "user", "42", EMPTY, arm("a"), T0);
    seen.set("flag", "run-1", "workspace", "42", EMPTY, arm("b"), T0);
    const user = seen.get("flag", "user", "42", EMPTY, T0);
    const workspace = seen.get("flag", "workspace", "42", EMPTY, T0);
    expect(user.kind === "hit" && user.entry.variant).toBe("a");
    expect(workspace.kind === "hit" && workspace.entry.variant).toBe("b");
    expect(seen.size).toBe(2);
  });

  it("stores a null variant (200 no-match) as a distinct cached entry", () => {
    const seen = new SeenSet();
    seen.set("flag", "run-1", "user", "user-1", EMPTY, { variant: null, variantName: null }, T0);
    const entry = seen.get("flag", "user", "user-1", EMPTY, T0 + 1);
    expect(entry.kind).toBe("hit");
    if (entry.kind === "hit") {
      expect(entry.entry.variant).toBeNull();
    }
  });

  it("within-TTL set replaces the fingerprint value but keeps the first-touch runId", () => {
    // A fresh Exposure slot is written under run-1. A later set for the same
    // identity within the TTL (the context-miss merge path) updates the cached
    // Variant but must not pretend a new Run was discovered — verify carries no
    // runId, and Run-boundary detection is the TTL miss path.
    const seen = new SeenSet();
    seen.set("flag", "run-1", "user", "user-1", EMPTY, arm("a"), T0);
    seen.set("flag", "run-2", "user", "user-1", EMPTY, arm("b"), T0 + 100);
    const lookup = seen.get("flag", "user", "user-1", EMPTY, T0 + 200);
    expect(lookup.kind).toBe("hit");
    if (lookup.kind === "hit") {
      expect(lookup.entry.variant).toBe("b");
      expect(lookup.entry.runId).toBe("run-1");
    }
    expect(seen.size).toBe(1);
    // A different fingerprint against the same slot still reports the first-touch runId.
    expect(seen.get("flag", "user", "user-1", { other: true }, T0 + 200)).toEqual({
      kind: "context-miss",
      runId: "run-1",
    });
  });
});

describe("SeenSet: attributes participate in value replay, not Exposure identity", () => {
  it("different attributes against a fresh Exposure slot are a context-miss", () => {
    const seen = new SeenSet();
    seen.set("flag", "run-1", "user", "u1", { plan: "free" }, arm("free"), T0);
    const lookup = seen.get("flag", "user", "u1", { plan: "enterprise" }, T0 + 1);
    expect(lookup).toEqual({ kind: "context-miss", runId: "run-1" });
    // One Exposure slot — attribute churn must not create a second identity.
    expect(seen.size).toBe(1);
  });

  it("storing a second attribute fingerprint keeps a single Exposure slot", () => {
    const seen = new SeenSet();
    seen.set("flag", "run-1", "user", "u1", { plan: "free" }, arm("free"), T0);
    seen.set("flag", "run-1", "user", "u1", { plan: "enterprise" }, arm("ent"), T0 + 1);
    expect(seen.size).toBe(1);
    const free = seen.get("flag", "user", "u1", { plan: "free" }, T0 + 2);
    const ent = seen.get("flag", "user", "u1", { plan: "enterprise" }, T0 + 2);
    expect(free.kind === "hit" && free.entry.variant).toBe("free");
    expect(ent.kind === "hit" && ent.entry.variant).toBe("ent");
  });

  it("attribute maps that differ only in property order fingerprint identically", () => {
    expect(fingerprintAttributes({ b: 1, a: "x" })).toBe(fingerprintAttributes({ a: "x", b: 1 }));
    const seen = new SeenSet();
    seen.set("flag", "run-1", "user", "u1", { b: 1, a: "x" }, arm("v"), T0);
    const lookup = seen.get("flag", "user", "u1", { a: "x", b: 1 }, T0 + 1);
    expect(lookup.kind).toBe("hit");
  });
});

describe("SeenSet: LRU eviction", () => {
  it("evicts the least-recently-used entry at capacity", () => {
    const seen = new SeenSet(2);
    seen.set("f", "r", "user", "a", EMPTY, { variant: 1, variantName: "one" }, T0);
    seen.set("f", "r", "user", "b", EMPTY, { variant: 2, variantName: "two" }, T0);
    // Touch "a" so "b" becomes least-recently-used.
    expect(seen.get("f", "user", "a", EMPTY, T0).kind).toBe("hit");
    seen.set("f", "r", "user", "c", EMPTY, { variant: 3, variantName: "three" }, T0);
    expect(seen.size).toBe(2);
    expect(seen.get("f", "user", "b", EMPTY, T0).kind).toBe("miss"); // evicted
    expect(seen.get("f", "user", "a", EMPTY, T0).kind === "hit").toBe(true);
    expect(seen.get("f", "user", "c", EMPTY, T0).kind === "hit").toBe(true);
  });

  it("evicts the least-recently-used attribute fingerprint inside one Exposure slot", () => {
    // maxSize=10 Exposure slots, maxValuesPerEntry=2 fingerprints per slot.
    const seen = new SeenSet(10, 60_000, 2);
    seen.set("f", "r", "user", "u1", { n: 1 }, arm("one"), T0);
    seen.set("f", "r", "user", "u1", { n: 2 }, arm("two"), T0);
    // Touch fingerprint 1 so 2 becomes least-recently-used.
    expect(seen.get("f", "user", "u1", { n: 1 }, T0).kind).toBe("hit");
    seen.set("f", "r", "user", "u1", { n: 3 }, arm("three"), T0);
    expect(seen.size).toBe(1); // still one Exposure identity
    expect(seen.get("f", "user", "u1", { n: 2 }, T0).kind).toBe("context-miss"); // evicted
    expect(seen.get("f", "user", "u1", { n: 1 }, T0).kind === "hit").toBe(true);
    expect(seen.get("f", "user", "u1", { n: 3 }, T0).kind === "hit").toBe(true);
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

  it("exposes a bounded default for per-identity attribute fingerprints", () => {
    expect(DEFAULT_VALUES_PER_ENTRY).toBe(64);
  });
});
