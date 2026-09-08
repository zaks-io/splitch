import { describe, expect, it } from "vitest";
import { formatFlagRead } from "./format-flag-read.js";
import { flagRecord } from "./test-fixtures.js";

describe("formatFlagRead", () => {
  it("escapes stored terminal controls in hydrated Flag output", () => {
    const output = formatFlagRead(
      "flags_get",
      {
        ...flagRecord,
        id: "flag_1\u001b]8;;https://attacker.example\u0007",
        appId: "app_1\u202e",
        key: "checkout\u001b[2J",
        name: "Checkout\u001b]52;c;owned\u0007",
        description: "line one\nline two\u202egol",
        defaultVariantId: "variant_off\u000dspoofed",
        variants: flagRecord.variants.map((variant) => ({
          ...variant,
          name: `${variant.name}\tspoofed`,
        })),
        configurations: [
          {
            environmentId: "env_dev\u000aspoofed",
            enabled: true,
            availableVariantNames: ["on\rspoofed"],
            targetingRules: [],
            rollout: { percentage: 25, salt: "cohort\u001b]0;spoofed\u0007" },
            experiment: { id: "exp_1\u0009spoofed", key: "checkout\u2066spoofed" },
          },
        ],
      },
      false,
    );

    expect(output).toContain("Checkout\\u001b]52;c;owned\\u0007");
    expect(output).toContain("line one\\u000aline two\\u202egol");
    expect(output).toContain("on\\u0009spoofed");
    expect(output).toContain("on\\u000dspoofed");
    expect(output).toContain("Key: checkout\\u001b[2J");
    expect(output).toContain("salt cohort\\u001b]0;spoofed\\u0007");
    expect(output).toContain("checkout\\u2066spoofed (exp_1\\u0009spoofed)");
    expect(output).not.toContain("\u001b");
  });
});
