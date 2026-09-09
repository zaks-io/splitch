import { describe, expect, it } from "vitest";
import { canonicalHash, canonicalJson } from "./canonical-json";

describe("RFC 8785 canonical JSON", () => {
  it("sorts object keys by UTF-16 code unit at every depth without reordering arrays", () => {
    expect(
      canonicalJson({
        z: [{ b: 2, a: 1 }, "second"],
        "\ue000": true,
        "😀": false,
        a: { y: 2, x: 1 },
      }),
    ).toBe('{"a":{"x":1,"y":2},"z":[{"a":1,"b":2},"second"],"😀":false,"":true}');
  });

  it("uses the RFC 8785 ECMAScript number representation", () => {
    expect(canonicalJson([Number("333333333.33333329"), 1e30, 4.5, 2e-3, 1e-27])).toBe(
      "[333333333.3333333,1e+30,4.5,0.002,1e-27]",
    );
  });

  it("hashes equivalent object order and number spellings identically", async () => {
    const first = { count: 1, nested: { rate: 1e-3, values: [1.0, 1] } };
    const second = { nested: { values: [1, 1], rate: 0.001 }, count: 1.0 };

    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(await canonicalHash(first)).toBe(await canonicalHash(second));
    expect(await canonicalHash({ b: 2, a: 1 })).toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
  });

  it("rejects lone Unicode surrogates in values and property names", () => {
    expect(() => canonicalJson("\ud800")).toThrow(/lone Unicode surrogates/);
    expect(() => canonicalJson("\udc00")).toThrow(/lone Unicode surrogates/);
    expect(() => canonicalJson(Object.fromEntries([["\ud800", true]]))).toThrow(
      /lone Unicode surrogates/,
    );
    expect(canonicalJson("😀")).toBe('"😀"');
  });

  it("preserves the approval request hash produced before the shared extraction", async () => {
    const approvalRequest = {
      target: { type: "flag_configuration", id: "cfg_01" },
      proposalInput: {
        rollout: [{ variant: "treatment", percentage: 100 }],
        enabled: true,
      },
      operation: "experiment_winner_promote",
    };

    expect(await canonicalHash(approvalRequest)).toBe(
      "sha256:8b27d87f3748035cd236f30635b4f2dd3434f948d31d7676fbd6bae02eadb106",
    );
  });
});
