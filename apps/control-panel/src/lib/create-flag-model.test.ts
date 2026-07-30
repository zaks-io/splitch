import { CreateFlagRequestSchema } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import type { MutationErrorSurface } from "./api";
import {
  booleanPresetDraft,
  draftIssues,
  type FlagDraft,
  FlagDraftSchema,
  flagCreateInput,
  flagFieldError,
  issueFor,
  moveVariant,
  removeVariant,
  switchValueType,
  typeSwitchClearsValues,
  type VariantValueType,
} from "./create-flag-model";

function draft(overrides: Partial<FlagDraft> = {}): FlagDraft {
  return { ...booleanPresetDraft(), key: "new-checkout", ...overrides };
}

function rows(valueType: VariantValueType, ...values: string[]) {
  return {
    valueType,
    variants: values.map((value, index) => ({
      name: `variant-${index}`,
      value,
      description: "",
    })),
  };
}

describe("Create Flag preset", () => {
  it("opens as the zero-configuration on/off pair with disabled as the Default", () => {
    expect(flagCreateInput("app_checkout", draft({ key: " new-checkout " }), "idem-1")).toEqual({
      appId: "app_checkout",
      key: "new-checkout",
      idempotency_key: "idem-1",
      name: "New Checkout",
      schema: { type: "boolean" },
      variants: [
        { name: "disabled", value: false, isDefault: true },
        { name: "enabled", value: true, isDefault: false },
      ],
    });
  });
});

describe("Create Flag value types", () => {
  const cases: Array<{ valueType: VariantValueType; raw: string[]; parsed: unknown[] }> = [
    { valueType: "boolean", raw: ["false", "true"], parsed: [false, true] },
    { valueType: "string", raw: ["control", "treatment"], parsed: ["control", "treatment"] },
    { valueType: "number", raw: ["0", "12.5"], parsed: [0, 12.5] },
    {
      valueType: "object",
      raw: ['{"limit":1}', '{"limit":10}'],
      parsed: [{ limit: 1 }, { limit: 10 }],
    },
  ];

  for (const { valueType, raw, parsed } of cases) {
    it(`round-trips ${valueType} Variant values into the create payload`, () => {
      const input = flagCreateInput("app_checkout", draft(rows(valueType, ...raw)), "idem-1");

      expect(input.schema).toEqual({ type: valueType });
      expect(input.variants.map((variant) => variant.value)).toEqual(parsed);
      expect(CreateFlagRequestSchema.safeParse(input).success).toBe(true);
    });
  }

  it("reports an inline parse error instead of sending a malformed JSON object", () => {
    const issues = draftIssues(draft(rows("object", "{ not json", '{"ok":true}')));

    expect(issueFor(issues, "variants.0.value")).toBe("Enter a JSON object.");
    expect(issueFor(issues, "variants.1.value")).toBeUndefined();
  });

  it("rejects a JSON array, since a Variant value must be an object", () => {
    expect(issueFor(draftIssues(draft(rows("object", "[1,2]", "{}"))), "variants.0.value")).toBe(
      "Enter a JSON object.",
    );
  });

  it("clears values a type switch cannot preserve, and only then", () => {
    const stringDraft = draft(rows("string", "control", "treatment"));

    expect(typeSwitchClearsValues(stringDraft.variants, "number")).toBe(true);
    expect(switchValueType(stringDraft, "number").variants.map((row) => row.value)).toEqual([
      "",
      "",
    ]);

    const numeric = draft(rows("string", "1", "2"));
    expect(typeSwitchClearsValues(numeric.variants, "number")).toBe(false);
    expect(switchValueType(numeric, "number").variants.map((row) => row.value)).toEqual(["1", "2"]);
  });
});

describe("Create Flag catalog invariants", () => {
  it("refuses duplicate Variant names, because allocation is keyed by name", () => {
    const duplicated = draft({
      variants: [
        { name: "on", value: "true", description: "" },
        { name: "on", value: "false", description: "" },
      ],
    });

    expect(issueFor(draftIssues(duplicated), "variants.1.name")).toBe(
      '"on" is already used by Variant 1.',
    );
  });

  it("requires at least one Variant", () => {
    expect(issueFor(draftIssues(draft({ variants: [], defaultIndex: -1 })), "variants")).toBe(
      "A Flag needs at least one Variant.",
    );
  });

  it("never auto-promotes a Default when the Default Variant is removed", () => {
    const removed = removeVariant(draft(), 0);

    expect(removed.defaultIndex).toBe(-1);
    expect(issueFor(draftIssues(removed), "defaultIndex")).toBe(
      "Choose which Variant is the Default.",
    );
  });

  it("keeps the Default pointing at the same Variant after a reorder", () => {
    const reordered = moveVariant(draft(), 0, 1);

    expect(reordered.variants.map((row) => row.name)).toEqual(["enabled", "disabled"]);
    expect(reordered.defaultIndex).toBe(1);
    expect(flagCreateInput("app_checkout", reordered, "idem-1").variants).toEqual([
      { name: "enabled", value: true, isDefault: false },
      { name: "disabled", value: false, isDefault: true },
    ]);
  });

  it("shifts the Default index down when an earlier, non-Default Variant is removed", () => {
    expect(removeVariant(draft({ defaultIndex: 1 }), 0).defaultIndex).toBe(0);
  });

  it("carries an optional Variant description and omits it when blank", () => {
    const described = draft({
      variants: [
        { name: "disabled", value: "false", description: " off for everyone " },
        { name: "enabled", value: "true", description: "  " },
      ],
    });

    expect(flagCreateInput("app_checkout", described, "idem-1").variants).toEqual([
      { name: "disabled", value: false, isDefault: true, description: "off for everyone" },
      { name: "enabled", value: true, isDefault: false },
    ]);
  });

  it("refuses to build a payload the contract would reject", () => {
    expect(() => flagCreateInput("app_checkout", draft({ key: "  " }), "idem-1")).toThrow(
      "refusing to build an invalid Flag",
    );
  });
});

describe("Flag draft wire shape", () => {
  it("accepts a well-formed draft", () => {
    expect(FlagDraftSchema.safeParse(draft()).success).toBe(true);
  });

  /**
   * The create server fn parses rather than casts, so a malformed body is
   * rejected before `draftIssues` dereferences it into a 500 (ADR-0036).
   */
  const malformed: Array<[string, unknown]> = [
    ["a missing draft", undefined],
    ["a non-object draft", "new-checkout"],
    ["missing variants", { key: "k", valueType: "boolean", defaultIndex: 0 }],
    ["variants as a non-array", { ...draft(), variants: "disabled" }],
    ["a variant missing its value", { ...draft(), variants: [{ name: "disabled" }] }],
    ["an unknown value type", { ...draft(), valueType: "date" }],
    ["a non-numeric defaultIndex", { ...draft(), defaultIndex: "0" }],
  ];
  for (const [label, input] of malformed) {
    it(`refuses ${label}`, () => {
      expect(FlagDraftSchema.safeParse(input).success).toBe(false);
    });
  }
});

describe("Create Flag error surfacing", () => {
  it("places Worker key validation on the key field", () => {
    const error: MutationErrorSurface = {
      kind: "field",
      message: "validation failed",
      fields: [{ field: "body.key", code: "VALIDATION_ERROR", message: "flag key already exists" }],
    };

    expect(flagFieldError(error, "key")).toBe("flag key already exists");
  });
});
