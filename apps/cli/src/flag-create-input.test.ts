import { CreateFlagRequestSchema } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  applyFlagsCreateConvenienceFields,
  assertContractValidFlagsCreateInput,
  CliInputError,
  flagNameFromKey,
  parseBooleanVariantsFlag,
} from "./flag-create-input.js";

describe("parseBooleanVariantsFlag", () => {
  it("builds the canonical on/off catalog with off as the Default Variant", () => {
    expect(parseBooleanVariantsFlag("on,off")).toEqual([
      { name: "on", value: true, isDefault: false },
      { name: "off", value: false, isDefault: true },
    ]);
  });

  it("rejects duplicate Variant names before any write", () => {
    expect(() => parseBooleanVariantsFlag("on,on")).toThrow(CliInputError);
  });

  it("rejects ambiguous boolean values", () => {
    expect(() => parseBooleanVariantsFlag("on,true")).toThrow(CliInputError);
  });

  it("rejects unknown Variant names", () => {
    expect(() => parseBooleanVariantsFlag("on,maybe")).toThrow(CliInputError);
  });
});

describe("applyFlagsCreateConvenienceFields", () => {
  it("derives the quickstart FlagsCreateInput shape", () => {
    const input: Record<string, unknown> = { appId: "app_checkout" };
    applyFlagsCreateConvenienceFields(input, {
      key: " new-checkout ",
      variants: "on,off",
    });

    expect(input).toEqual({
      appId: "app_checkout",
      key: "new-checkout",
      name: "New Checkout",
      schema: { type: "boolean" },
      variants: [
        { name: "on", value: true, isDefault: false },
        { name: "off", value: false, isDefault: true },
      ],
    });
    expect(CreateFlagRequestSchema.safeParse(input).success).toBe(true);
  });

  it("keeps advanced --body-json catalogs when --variants is omitted", () => {
    const input: Record<string, unknown> = {
      appId: "app_checkout",
      key: "checkout",
      name: "Checkout",
      schema: null,
      variants: [{ name: "control", value: false, isDefault: true }],
    };

    applyFlagsCreateConvenienceFields(input, { key: "checkout" });
    expect(input.variants).toEqual([{ name: "control", value: false, isDefault: true }]);
  });

  it("requires a variant catalog when neither --variants nor body variants are present", () => {
    const input: Record<string, unknown> = { appId: "app_checkout", key: "checkout" };
    expect(() => applyFlagsCreateConvenienceFields(input, { key: "checkout" })).toThrow(
      CliInputError,
    );
  });
});

describe("flagNameFromKey", () => {
  it("title-cases dashed keys", () => {
    expect(flagNameFromKey("new-checkout")).toBe("New Checkout");
  });
});

describe("assertContractValidFlagsCreateInput", () => {
  it("accepts a contract-valid quickstart payload", () => {
    const input = {
      appId: "app_checkout",
      key: "new-checkout",
      name: flagNameFromKey("new-checkout"),
      schema: { type: "boolean" },
      variants: parseBooleanVariantsFlag("on,off"),
    };

    expect(() => assertContractValidFlagsCreateInput(input)).not.toThrow();
  });
});
