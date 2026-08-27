import { describe, expect, it } from "vitest";
import { CliInputError } from "./flag-create-input.js";
import {
  buildAppendedTargetingRule,
  mintTargetingRuleId,
  nextRulePriority,
  parseFlagTargetingRulesAddInput,
  parseWhenCondition,
  resolveVariantByName,
} from "./flag-targeting-rules-add-input.js";
import { parseInvocation } from "./parse-args.js";

describe("parseWhenCondition", () => {
  it("parses attr=value into an equality Condition", () => {
    expect(parseWhenCondition("plan=enterprise")).toEqual({
      attribute: "plan",
      operator: "eq",
      value: "enterprise",
    });
  });

  it("trims both sides and keeps values after the first =", () => {
    expect(parseWhenCondition(" plan = enterprise ")).toEqual({
      attribute: "plan",
      operator: "eq",
      value: "enterprise",
    });
    expect(parseWhenCondition("label==x")).toEqual({
      attribute: "label",
      operator: "eq",
      value: "=x",
    });
  });

  it("keeps numeric-looking and boolean-looking values as strings", () => {
    expect(parseWhenCondition("postalCode=001")).toEqual({
      attribute: "postalCode",
      operator: "eq",
      value: "001",
    });
    expect(parseWhenCondition("externalId=18")).toEqual({
      attribute: "externalId",
      operator: "eq",
      value: "18",
    });
    expect(parseWhenCondition("label=true")).toEqual({
      attribute: "label",
      operator: "eq",
      value: "true",
    });
  });

  it("rejects malformed tokens", () => {
    for (const token of ["plan", "=enterprise", "plan=", "=", ""]) {
      expect(() => parseWhenCondition(token)).toThrow(CliInputError);
    }
  });
});

describe("parseFlagTargetingRulesAddInput", () => {
  it("requires --when and --serve", () => {
    expect(() =>
      parseFlagTargetingRulesAddInput(parseInvocation(["flag-targeting-rules", "add", "flag_1"])),
    ).toThrow(/requires --when/);
    expect(() =>
      parseFlagTargetingRulesAddInput(
        parseInvocation(["flag-targeting-rules", "add", "flag_1", "--when", "plan=enterprise"]),
      ),
    ).toThrow(/requires --serve/);
  });

  it("collects repeatable --when as AND Conditions", () => {
    const input = parseFlagTargetingRulesAddInput(
      parseInvocation([
        "flag-targeting-rules",
        "add",
        "flag_1",
        "--when",
        "plan=enterprise",
        "--when",
        "beta=true",
        "--serve",
        "on",
      ]),
    );
    expect(input.variantName).toBe("on");
    expect(input.conditions).toEqual([
      { attribute: "plan", operator: "eq", value: "enterprise" },
      { attribute: "beta", operator: "eq", value: "true" },
    ]);
  });

  it("rejects --body-json so the raw path stays on replace", () => {
    expect(() =>
      parseFlagTargetingRulesAddInput(
        parseInvocation([
          "flag-targeting-rules",
          "add",
          "flag_1",
          "--when",
          "plan=enterprise",
          "--serve",
          "on",
          "--body-json",
          "{}",
        ]),
      ),
    ).toThrow(/does not accept --body-json/);
  });
});

describe("resolveVariantByName", () => {
  const catalog = [
    { id: "var_on", name: "on" },
    { id: "var_off", name: "off" },
  ];

  it("resolves a unique catalog name", () => {
    expect(resolveVariantByName(catalog, "on")).toEqual({ id: "var_on", name: "on" });
  });

  it("fails loud with known names when the Variant is missing", () => {
    try {
      resolveVariantByName(catalog, "maybe");
      throw new Error("expected unknown Variant to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CliInputError);
      expect((error as CliInputError).message).toContain("Unknown Variant");
      expect((error as CliInputError).remediation).toContain("on, off");
    }
  });

  it("refuses an ambiguous catalog name", () => {
    expect(() =>
      resolveVariantByName(
        [
          { id: "var_a", name: "on" },
          { id: "var_b", name: "on" },
        ],
        "on",
      ),
    ).toThrow(/more than one catalog entry/);
  });
});

describe("buildAppendedTargetingRule", () => {
  it("mints an id, appends after existing priorities, and AND-combines Conditions", () => {
    const existing = [
      {
        id: "rule_old",
        flagId: "flag_1",
        priority: 2,
        conditions: [{ attribute: "plan", operator: "eq" as const, value: "free" }],
        variantId: "var_off",
      },
    ];
    const rule = buildAppendedTargetingRule({
      flagId: "flag_1",
      existing,
      conditions: [
        { attribute: "plan", operator: "eq", value: "enterprise" },
        { attribute: "beta", operator: "eq", value: "true" },
      ],
      variantId: "var_on",
      id: "rule_new",
    });
    expect(rule).toMatchObject({
      id: "rule_new",
      flagId: "flag_1",
      priority: 3,
      variantId: "var_on",
      percentageRollout: null,
      conditions: [
        { attribute: "plan", operator: "eq", value: "enterprise" },
        { attribute: "beta", operator: "eq", value: "true" },
      ],
    });
  });

  it("starts at priority 0 on a clean Flag", () => {
    expect(nextRulePriority([])).toBe(0);
    expect(mintTargetingRuleId()).toMatch(/^rule_[0-9a-f]{32}$/);
  });
});
