import { describe, expect, it } from "vitest";
import { ConditionMatchError, matchesConditions } from "./conditions";

describe("resolved Targeting Rule Conditions", () => {
  it("fails before an empty condition set can reach every", () => {
    expect(() =>
      matchesConditions([], {
        targetingKey: "user_1",
        idType: "user",
        attributes: {},
      }),
    ).toThrow(ConditionMatchError);
  });

  it("matches array-valued attributes through the shared evaluator re-export", () => {
    expect(
      matchesConditions([{ attribute: "roles", operator: "in", value: ["admin"] }], {
        targetingKey: "user_1",
        idType: "user",
        attributes: { roles: ["admin", "analyst"] },
      }),
    ).toBe(true);
    expect(
      matchesConditions([{ attribute: "roles", operator: "in", value: ["admin"] }], {
        targetingKey: "user_1",
        idType: "user",
        attributes: { roles: ["viewer"] },
      }),
    ).toBe(false);
  });
});
