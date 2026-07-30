import { describe, expect, it } from "vitest";
import { approvalDiff, canonicalHash, canonicalJson } from "./approval-canonical";

describe("approval canonicalization", () => {
  it("sorts object keys recursively without reordering arrays", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: true })).toBe('{"a":true,"z":[{"a":1,"b":2}]}');
  });

  it("hashes semantically identical object order byte-identically", async () => {
    expect(await canonicalHash({ b: 2, a: 1 })).toBe(await canonicalHash({ a: 1, b: 2 }));
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
