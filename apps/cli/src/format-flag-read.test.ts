import { describe, expect, it } from "vitest";
import { formatFlagRead } from "./format-flag-read.js";
import { flagRecord } from "./test-fixtures.js";

describe("formatFlagRead", () => {
  it("escapes stored terminal controls in hydrated Flag output", () => {
    const output = formatFlagRead(
      "flags_get",
      {
        ...flagRecord,
        name: "Checkout\u001b]52;c;owned\u0007",
        description: "line one\nline two\u202egol",
        variants: flagRecord.variants.map((variant) => ({
          ...variant,
          name: `${variant.name}\tspoofed`,
        })),
        configurations: [
          {
            environmentId: "env_dev",
            enabled: true,
            availableVariantNames: ["on\rspoofed"],
            targetingRules: [],
            rollout: null,
            experiment: null,
          },
        ],
      },
      false,
    );

    expect(output).toContain("Checkout\\u001b]52;c;owned\\u0007");
    expect(output).toContain("line one\\u000aline two\\u202egol");
    expect(output).toContain("on\\u0009spoofed");
    expect(output).toContain("on\\u000dspoofed");
    expect(output).not.toContain("\u001b");
  });
});
