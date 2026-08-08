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
});
