import { describe, expect, it } from "vitest";
import { errorCodes as contractErrorCodes } from "../../contracts/src/error-code";
import { resolutionReasons as contractResolutionReasons } from "../../contracts/src/leaves/resolution-reason";
import {
  DataPlaneEvaluateResponseSchema as ZodDataPlaneEvaluateResponseSchema,
  EvaluateAllResponseSchema as ZodEvaluateAllResponseSchema,
  PeekEvaluateResponseSchema as ZodPeekEvaluateResponseSchema,
  ResolutionDetailsSchema as ZodResolutionDetailsSchema,
} from "../../contracts/src/sdk-data-plane-surface";
import {
  DataPlaneEvaluateResponseSchema,
  ErrorCodeSchema,
  EvaluateAllResponseSchema,
  PeekEvaluateResponseSchema,
  ResolutionDetailsSchema,
} from "./generated/contract-surface.js";

type AnySchema = { safeParse: (input: unknown) => { success: boolean } };

function expectParity(compiled: AnySchema, zod: AnySchema, input: unknown, ok: boolean) {
  expect(compiled.safeParse(input).success).toBe(ok);
  expect(zod.safeParse(input).success).toBe(ok);
}

describe("contract-surface zod-free parity", () => {
  it("ErrorCodeSchema.options matches contracts errorCodes", () => {
    expect([...ErrorCodeSchema.options]).toEqual([...contractErrorCodes]);
  });

  it("ErrorCodeSchema.safeParse accepts only contract codes", () => {
    expect(ErrorCodeSchema.safeParse("FLAG_NOT_FOUND").success).toBe(true);
    expect(ErrorCodeSchema.safeParse("NOT_A_REAL_CODE").success).toBe(false);
  });

  it("resolution reason set matches contracts", () => {
    for (const reason of contractResolutionReasons) {
      const base = {
        value: true as const,
        variantName: "on",
        reason,
        ...(reason === "ERROR" ? { errorCode: "INTERNAL_SERVER_ERROR" as const } : {}),
        ...(reason === "TARGETING_MATCH" ? { ruleId: "rule-1" } : {}),
      };
      expectParity(ResolutionDetailsSchema, ZodResolutionDetailsSchema, base, true);
    }
  });

  it("DataPlaneEvaluateResponseSchema matches Zod", () => {
    const rows: { input: unknown; ok: boolean }[] = [
      { input: { variant: true }, ok: true },
      { input: { variant: null }, ok: true },
      { input: { variant: { a: 1 } }, ok: true },
      { input: { variant: true, extra: 1 }, ok: false },
      { input: {}, ok: false },
    ];
    for (const row of rows) {
      expectParity(
        DataPlaneEvaluateResponseSchema,
        ZodDataPlaneEvaluateResponseSchema,
        row.input,
        row.ok,
      );
    }
  });

  it("PeekEvaluateResponseSchema matches Zod", () => {
    const rows: { input: unknown; ok: boolean }[] = [
      { input: { variant: true }, ok: true },
      { input: { variant: null }, ok: false },
      { input: { variant: true, extra: 1 }, ok: false },
    ];
    for (const row of rows) {
      expectParity(PeekEvaluateResponseSchema, ZodPeekEvaluateResponseSchema, row.input, row.ok);
    }
  });

  it("ResolutionDetailsSchema matches Zod", () => {
    const rows: { input: unknown; ok: boolean }[] = [
      { input: { value: "treatment", variantName: "treatment", reason: "SPLIT" }, ok: true },
      { input: { value: false, variantName: null, reason: "ERROR" }, ok: false },
      {
        input: {
          value: false,
          variantName: null,
          reason: "ERROR",
          errorCode: "FLAG_NOT_FOUND",
          errorMessage: "missing",
        },
        ok: true,
      },
      { input: { value: true, variantName: "on", reason: "TARGETING_MATCH" }, ok: false },
      {
        input: { value: true, variantName: "on", reason: "TARGETING_MATCH", ruleId: "r1" },
        ok: true,
      },
    ];
    for (const row of rows) {
      expectParity(ResolutionDetailsSchema, ZodResolutionDetailsSchema, row.input, row.ok);
    }
  });

  it("EvaluateAllResponseSchema matches Zod", () => {
    const rows: { input: unknown; ok: boolean }[] = [
      {
        input: {
          evaluations: {
            "new-checkout": {
              variant: true,
              variantName: "on",
              reason: "SPLIT",
              errorCode: null,
              exposureTicket: "ticket",
            },
          },
        },
        ok: true,
      },
      {
        input: {
          evaluations: {
            "new-checkout": {
              variant: false,
              variantName: null,
              reason: "DEFAULT",
              errorCode: null,
              exposureTicket: "ticket",
            },
          },
        },
        ok: false,
      },
      { input: { evaluations: {}, extra: true }, ok: false },
    ];
    for (const row of rows) {
      expectParity(EvaluateAllResponseSchema, ZodEvaluateAllResponseSchema, row.input, row.ok);
    }
  });
});
