import type { Condition, EvaluationContext } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import { matchesConditions } from "./conditions";
import { ConditionMatchError } from "./errors";

function context(attributes: EvaluationContext["attributes"]): EvaluationContext {
  return { targetingKey: "user-1", idType: "user", attributes };
}

function match(
  operator: Condition["operator"],
  value: Condition["value"],
  attributes: EvaluationContext["attributes"],
  attribute = "roles",
): boolean {
  return matchesConditions([{ attribute, operator, value }], context(attributes));
}

describe("matchesConditions", () => {
  it("fails loud before an empty condition set can reach every", () => {
    expect(() => matchesConditions([], context({}))).toThrow(ConditionMatchError);
  });

  it("throws without embedding a configured regex and logs the pattern server-side", () => {
    const logger = { warn: vi.fn() };
    const pattern = "(unclosed";
    expect(() =>
      matchesConditions(
        [{ attribute: "email", operator: "matches", value: pattern }],
        context({ email: "ops@acme.com" }),
        { logger, ruleId: "rule-regex" },
      ),
    ).toThrow(ConditionMatchError);
    try {
      matchesConditions(
        [{ attribute: "email", operator: "matches", value: pattern }],
        context({ email: "ops@acme.com" }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ConditionMatchError);
      expect((error as Error).message).toBe("Invalid regex condition");
      expect((error as Error).message).not.toContain(pattern);
    }
    expect(logger.warn).toHaveBeenCalledWith("invalid_regex_condition", {
      pattern,
      ruleId: "rule-regex",
    });
  });

  it("treats an absent or null attribute as a non-match", () => {
    expect(match("eq", "admin", {})).toBe(false);
    expect(match("in", ["admin"], {})).toBe(false);
    expect(match("eq", "admin", { roles: null as never })).toBe(false);
  });
});

describe("scalar Evaluation Context attributes", () => {
  it("eq and neq keep whole-value Object.is comparison", () => {
    expect(match("eq", "admin", { roles: "admin" })).toBe(true);
    expect(match("eq", "admin", { roles: "analyst" })).toBe(false);
    expect(match("neq", "admin", { roles: "analyst" })).toBe(true);
    expect(match("neq", "admin", { roles: "admin" })).toBe(false);
    expect(match("eq", 1, { roles: "1" })).toBe(false);
    expect(match("eq", 0, { roles: -0 })).toBe(false);
    expect(match("eq", Number.NaN, { roles: Number.NaN })).toBe(true);
  });

  it("in and not_in compare the whole actual value to each expected member", () => {
    expect(match("in", ["admin", "analyst"], { roles: "admin" })).toBe(true);
    expect(match("in", ["admin"], { roles: "viewer" })).toBe(false);
    expect(match("not_in", ["admin"], { roles: "viewer" })).toBe(true);
    expect(match("not_in", ["admin"], { roles: "admin" })).toBe(false);
    expect(match("in", ["1"], { roles: 1 })).toBe(false);
  });

  it("empty expected lists never match in and always match not_in", () => {
    expect(match("in", [], { roles: "admin" })).toBe(false);
    expect(match("not_in", [], { roles: "admin" })).toBe(true);
  });
});

describe("array-valued Evaluation Context attributes", () => {
  it("eq matches when any element equals the scalar Condition value", () => {
    expect(match("eq", "admin", { roles: ["admin", "analyst"] })).toBe(true);
    expect(match("eq", "viewer", { roles: ["admin", "analyst"] })).toBe(false);
    expect(match("eq", 1, { roles: ["1"] })).toBe(false);
    expect(match("eq", ["admin"], { roles: ["admin"] })).toBe(false);
  });

  it("neq matches when no element equals the scalar Condition value", () => {
    expect(match("neq", "viewer", { roles: ["admin", "analyst"] })).toBe(true);
    expect(match("neq", "admin", { roles: ["admin", "analyst"] })).toBe(false);
  });

  it("in matches when any actual element is present in the expected list", () => {
    expect(match("in", ["admin"], { roles: ["admin", "analyst"] })).toBe(true);
    expect(match("in", ["viewer"], { roles: ["admin", "analyst"] })).toBe(false);
    expect(match("in", ["ADMIN"], { roles: ["admin"] })).toBe(false);
  });

  it("not_in matches only when no actual element is present in the expected list", () => {
    expect(match("not_in", ["viewer"], { roles: ["admin", "analyst"] })).toBe(true);
    expect(match("not_in", ["admin"], { roles: ["admin", "analyst"] })).toBe(false);
  });

  it("empty actual arrays never match eq or in and always match neq and not_in", () => {
    expect(match("eq", "admin", { roles: [] })).toBe(false);
    expect(match("neq", "admin", { roles: [] })).toBe(true);
    expect(match("in", ["admin"], { roles: [] })).toBe(false);
    expect(match("not_in", ["admin"], { roles: [] })).toBe(true);
  });

  it("empty expected lists never match in and always match not_in against an array actual", () => {
    expect(match("in", [], { roles: ["admin"] })).toBe(false);
    expect(match("not_in", [], { roles: ["admin"] })).toBe(true);
  });

  it("does not iterate array elements for numeric or regex operators", () => {
    expect(match("gt", 5, { roles: [10] })).toBe(false);
    expect(match("matches", "admin", { roles: ["admin"] })).toBe(false);
  });
});
