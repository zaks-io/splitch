import { describe, expect, it } from "vitest";
import { errorCodes as contractErrorCodes } from "../../contracts/src/error-code";
import { EvaluateAllReasonSchema as ZodEvaluateAllReasonSchema } from "../../contracts/src/leaves/evaluate-all-wire";
import { ResolutionReasonSchema as ZodResolutionReasonSchema } from "../../contracts/src/leaves/resolution-reason";
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

type ParseResult = { success: true; data: unknown } | { success: false; error?: unknown };
type AnySchema = { safeParse: (input: unknown) => ParseResult };

function expectParity(compiled: AnySchema, zod: AnySchema, input: unknown, ok: boolean) {
  const compiledResult = compiled.safeParse(input);
  const zodResult = zod.safeParse(input);
  expect(compiledResult.success).toBe(ok);
  expect(zodResult.success).toBe(ok);
  if (ok && compiledResult.success && zodResult.success) {
    expect(compiledResult.data).toEqual(zodResult.data);
  }
}

function wellFormedEvaluateAllEntry(reason: string) {
  return {
    variant: reason === "ERROR" ? null : true,
    variantName: reason === "ERROR" ? null : "on",
    reason,
    errorCode: reason === "ERROR" ? ("INTERNAL_SERVER_ERROR" as const) : null,
    exposureTicket: reason === "SPLIT" ? "ticket" : null,
  };
}

function resolutionDetailsForReason(reason: string) {
  return {
    value: true as const,
    variantName: "on",
    reason,
    ...(reason === "ERROR" ? { errorCode: "INTERNAL_SERVER_ERROR" as const } : {}),
    ...(reason === "TARGETING_MATCH" ? { ruleId: "rule-1" } : {}),
  };
}

describe("contract-surface enum lockstep", () => {
  it("ErrorCodeSchema.options matches contracts errorCodes", () => {
    expect([...ErrorCodeSchema.options]).toEqual([...contractErrorCodes]);
  });

  it("ErrorCodeSchema.safeParse accepts only contract codes", () => {
    expect(ErrorCodeSchema.safeParse("FLAG_NOT_FOUND").success).toBe(true);
    expect(ErrorCodeSchema.safeParse("NOT_A_REAL_CODE").success).toBe(false);
  });

  it("resolution reason set matches contracts", () => {
    for (const reason of ZodResolutionReasonSchema.options) {
      expectParity(
        ResolutionDetailsSchema,
        ZodResolutionDetailsSchema,
        resolutionDetailsForReason(reason),
        true,
      );
    }
  });

  it("evaluate-all reason set matches contracts", () => {
    for (const reason of ZodEvaluateAllReasonSchema.options) {
      expectParity(
        EvaluateAllResponseSchema,
        ZodEvaluateAllResponseSchema,
        { evaluations: { "new-checkout": wellFormedEvaluateAllEntry(reason) } },
        true,
      );
    }
  });
});

describe("contract-surface schema fixtures", () => {
  it("DataPlaneEvaluateResponseSchema matches Zod on shared domain", () => {
    for (const row of [
      { input: { variant: true }, ok: true },
      { input: { variant: null }, ok: true },
      { input: { variant: { a: 1 } }, ok: true },
      { input: {}, ok: false },
    ]) {
      expectParity(
        DataPlaneEvaluateResponseSchema,
        ZodDataPlaneEvaluateResponseSchema,
        row.input,
        row.ok,
      );
    }
  });

  it("PeekEvaluateResponseSchema matches Zod on shared domain", () => {
    for (const row of [
      { input: { variant: true }, ok: true },
      { input: { variant: null }, ok: false },
    ]) {
      expectParity(PeekEvaluateResponseSchema, ZodPeekEvaluateResponseSchema, row.input, row.ok);
    }
  });

  it("ResolutionDetailsSchema matches Zod", () => {
    for (const row of [
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
    ]) {
      expectParity(ResolutionDetailsSchema, ZodResolutionDetailsSchema, row.input, row.ok);
    }
  });

  it("EvaluateAllResponseSchema matches Zod on shared domain", () => {
    for (const row of [
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
    ]) {
      expectParity(EvaluateAllResponseSchema, ZodEvaluateAllResponseSchema, row.input, row.ok);
    }
  });

  it("scalar empty-string and boundary cases match Zod", () => {
    for (const row of [
      { input: { value: true, variantName: "", reason: "SPLIT" }, ok: true },
      { input: { value: "", variantName: "on", reason: "SPLIT" }, ok: true },
      { input: { value: 0, variantName: "on", reason: "SPLIT" }, ok: true },
      {
        input: { value: true, variantName: "", reason: "TARGETING_MATCH", ruleId: "" },
        ok: true,
      },
      {
        input: {
          value: false,
          variantName: "",
          reason: "ERROR",
          errorCode: "FLAG_NOT_FOUND",
          errorMessage: "",
        },
        ok: true,
      },
    ]) {
      expectParity(ResolutionDetailsSchema, ZodResolutionDetailsSchema, row.input, row.ok);
    }
    expectParity(
      EvaluateAllResponseSchema,
      ZodEvaluateAllResponseSchema,
      {
        evaluations: {
          "new-checkout": {
            variant: "",
            variantName: "",
            reason: "SPLIT",
            errorCode: null,
            exposureTicket: "",
          },
        },
      },
      true,
    );
    expectParity(
      DataPlaneEvaluateResponseSchema,
      ZodDataPlaneEvaluateResponseSchema,
      { variant: "" },
      true,
    );
    expectParity(PeekEvaluateResponseSchema, ZodPeekEvaluateResponseSchema, { variant: 0 }, true);
  });

  it("response parsers strip unknown keys instead of rejecting (server-ahead)", () => {
    const evaluate = DataPlaneEvaluateResponseSchema.safeParse({ variant: true, sneaky: 1 });
    expect(evaluate.success).toBe(true);
    if (evaluate.success) {
      expect(evaluate.data).toEqual({ variant: true });
    }

    const evaluateAll = EvaluateAllResponseSchema.safeParse({
      evaluations: { flag: wellFormedEvaluateAllEntry("DEFAULT") },
      runId: "run_ahead",
    });
    expect(evaluateAll.success).toBe(true);
    if (evaluateAll.success) {
      expect(evaluateAll.data).toEqual({
        evaluations: { flag: wellFormedEvaluateAllEntry("DEFAULT") },
      });
    }

    const entryWithExtra = EvaluateAllResponseSchema.safeParse({
      evaluations: {
        flag: { ...wellFormedEvaluateAllEntry("DEFAULT"), runId: "run_ahead" },
      },
    });
    expect(entryWithExtra.success).toBe(true);
    if (entryWithExtra.success) {
      expect(entryWithExtra.data.evaluations.flag).toEqual(wellFormedEvaluateAllEntry("DEFAULT"));
    }
  });
});

describe("contract-surface __proto__ parity", () => {
  it("both refuse an own __proto__ Flag Key with the contract message", () => {
    const input = JSON.parse(
      '{"evaluations":{"__proto__":{"variant":false,"variantName":null,"reason":"DEFAULT","errorCode":null,"exposureTicket":null}}}',
    ) as unknown;

    const compiled = EvaluateAllResponseSchema.safeParse(input);
    const zod = ZodEvaluateAllResponseSchema.safeParse(input);
    expect(compiled.success).toBe(false);
    expect(zod.success).toBe(false);
    if (!compiled.success) {
      expect(compiled.error.message).toBe('must not contain a "__proto__" key');
    }
    if (!zod.success) {
      expect(zod.error.issues).toContainEqual(
        expect.objectContaining({
          code: "custom",
          message: 'must not contain a "__proto__" key',
          path: ["evaluations", "__proto__"],
        }),
      );
    }
  });

  it("compiled strips a JSON own __proto__ sibling key; zod 4.4.3 also strips it", () => {
    // Sibling __proto__ is not a flag key. Both sides strip it on responses.
    // Pin all three strict response schemas — this is the SPL-353 surface.
    const evaluateInput = JSON.parse('{"variant":true,"__proto__":{"x":1}}') as unknown;
    const evaluateCompiled = DataPlaneEvaluateResponseSchema.safeParse(evaluateInput);
    const evaluateZod = ZodDataPlaneEvaluateResponseSchema.safeParse(evaluateInput);
    expect(evaluateCompiled.success).toBe(true);
    expect(evaluateZod.success).toBe(true);
    if (evaluateCompiled.success) {
      expect(evaluateCompiled.data).toEqual({ variant: true });
    }

    const peekInput = JSON.parse('{"variant":true,"__proto__":{"x":1}}') as unknown;
    const peekCompiled = PeekEvaluateResponseSchema.safeParse(peekInput);
    const peekZod = ZodPeekEvaluateResponseSchema.safeParse(peekInput);
    expect(peekCompiled.success).toBe(true);
    expect(peekZod.success).toBe(true);
    if (peekCompiled.success) {
      expect(peekCompiled.data).toEqual({ variant: true });
    }

    const evaluateAllInput = JSON.parse('{"evaluations":{},"__proto__":{"x":1}}') as unknown;
    const evaluateAllCompiled = EvaluateAllResponseSchema.safeParse(evaluateAllInput);
    const evaluateAllZod = ZodEvaluateAllResponseSchema.safeParse(evaluateAllInput);
    expect(evaluateAllCompiled.success).toBe(true);
    expect(evaluateAllZod.success).toBe(true);
    if (evaluateAllCompiled.success) {
      expect(evaluateAllCompiled.data).toEqual({ evaluations: {} });
    }
  });
});
