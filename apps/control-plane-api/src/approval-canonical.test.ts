import { describe, expect, it } from "vitest";
import { approvalDiff, canonicalHash, canonicalJson } from "./approval-canonical";

describe("approval canonicalization", () => {
  it("sorts object keys recursively without reordering arrays", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: true })).toBe('{"a":true,"z":[{"a":1,"b":2}]}');
  });

  it("hashes semantically identical object order byte-identically", async () => {
    expect(await canonicalHash({ b: 2, a: 1 })).toBe(await canonicalHash({ a: 1, b: 2 }));
  });

  it("omits an explicitly-undefined property exactly as JSON.stringify does", () => {
    const patch = { a: 1, b: undefined };
    expect(canonicalJson(patch)).toBe(JSON.stringify(patch));
    expect(canonicalJson(patch)).toBe('{"a":1}');
  });

  it("treats an undefined property as absent rather than as a change", () => {
    expect(approvalDiff({ a: 1 }, { a: 1, b: undefined }).entries).toEqual([]);
  });

  it("orders diff paths by code unit, not by ICU collation", () => {
    // `localeCompare` puts "/a" before "/B"; code-unit order puts "/B" first.
    // The diff is hashed, so a runtime-dependent order is a second canonical form.
    expect(approvalDiff({ B: 1, a: 1 }, { B: 2, a: 2 }).entries.map((entry) => entry.path)).toEqual(
      ["/B", "/a"],
    );
  });

  it("emits sorted RFC 6901 paths", () => {
    expect(
      approvalDiff({ "a/b": 1, nested: { "~key": false } }, { "a/b": 2, nested: { "~key": true } })
        .entries,
    ).toEqual([
      { path: "/a~1b", operation: "replace", current: 1, proposed: 2 },
      {
        path: "/nested/~0key",
        operation: "replace",
        current: false,
        proposed: true,
      },
    ]);
  });
});
