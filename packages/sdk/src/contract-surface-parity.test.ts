import { describe, expect, it } from "vitest";
import { errorCodes as contractErrorCodes } from "../../contracts/src/error-code";
import { EvaluateAllReasonSchema as ZodEvaluateAllReasonSchema } from "../../contracts/src/leaves/evaluate-all-wire";
import { resolutionReasons as contractResolutionReasons } from "../../contracts/src/leaves/resolution-reason";
import {
  DataPlaneEvaluateResponseSchema as ZodDataPlaneEvaluateResponseSchema,
  EvaluateAllResponseSchema as ZodEvaluateAllResponseSchema,
  PeekEvaluateResponseSchema as ZodPeekEvaluateResponseSchema,
  ResolutionDetailsSchema as ZodResolutionDetailsSchema,
} from "../../contracts/src/sdk-data-plane-surface";
import {
  evaluateAllReasons as compiledEvaluateAllReasons,
  resolutionReasons as compiledResolutionReasons,
} from "../scripts/contract-surface-enums";
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

function resolutionDetailsForReason(reason: (typeof contractResolutionReasons)[number]) {
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

  it("resolutionReasons matches contracts exactly", () => {
    expect([...compiledResolutionReasons]).toEqual([...contractResolutionReasons]);
  });

  it("evaluateAllReasons matches contracts exactly", () => {
    expect([...compiledEvaluateAllReasons]).toEqual([...ZodEvaluateAllReasonSchema.options]);
  });

  it("resolution reason set matches contracts", () => {
    for (const reason of contractResolutionReasons) {
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
      const input = {
        evaluations: {
          "new-checkout": wellFormedEvaluateAllEntry(reason),
        },
      };
      expectParity(EvaluateAllResponseSchema, ZodEvaluateAllResponseSchema, input, true);
    }
  });
});

describe("contract-surface schema fixtures", () => {
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

  it("scalar empty-string and boundary cases match Zod", () => {
    // Catch contracts tightening a string with `.min(1)` (or similar) without
    // a matching mirror change — enum/required-field drift alone is not enough.
    const resolutionRows: { input: unknown; ok: boolean }[] = [
      { input: { value: true, variantName: "", reason: "SPLIT" }, ok: true },
      { input: { value: "", variantName: "on", reason: "SPLIT" }, ok: true },
      { input: { value: 0, variantName: "on", reason: "SPLIT" }, ok: true },
      { input: { value: -0, variantName: "a", reason: "SPLIT" }, ok: true },
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
    ];
    for (const row of resolutionRows) {
      expectParity(ResolutionDetailsSchema, ZodResolutionDetailsSchema, row.input, row.ok);
    }

    const evaluateAllRows: { input: unknown; ok: boolean }[] = [
      {
        input: {
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
        ok: true,
      },
      {
        input: {
          evaluations: {
            "new-checkout": {
              variant: 0,
              variantName: null,
              reason: "DEFAULT",
              errorCode: null,
              exposureTicket: null,
            },
          },
        },
        ok: true,
      },
    ];
    for (const row of evaluateAllRows) {
      expectParity(EvaluateAllResponseSchema, ZodEvaluateAllResponseSchema, row.input, row.ok);
    }

    expectParity(
      DataPlaneEvaluateResponseSchema,
      ZodDataPlaneEvaluateResponseSchema,
      { variant: "" },
      true,
    );
    expectParity(
      DataPlaneEvaluateResponseSchema,
      ZodDataPlaneEvaluateResponseSchema,
      { variant: 0 },
      true,
    );
    expectParity(PeekEvaluateResponseSchema, ZodPeekEvaluateResponseSchema, { variant: "" }, true);
    expectParity(PeekEvaluateResponseSchema, ZodPeekEvaluateResponseSchema, { variant: 0 }, true);
  });
});

describe("contract-surface known __proto__ divergences", () => {
  it("EvaluateAllResponseSchema keeps a __proto__ flag key as an own property", () => {
    // JSON.parse creates __proto__ as an own property; Object.entries yields it.
    // A plain `evaluations[flagKey] = …` assignment would hit the prototype setter.
    const input = JSON.parse(
      '{"evaluations":{"__proto__":{"variant":false,"variantName":null,"reason":"DEFAULT","errorCode":null,"exposureTicket":null}}}',
    ) as unknown;

    const compiled = EvaluateAllResponseSchema.safeParse(input);
    expect(compiled.success).toBe(true);
    if (!compiled.success) {
      return;
    }

    const evaluations = compiled.data.evaluations;
    // Normal prototype: Record consumers can call hasOwnProperty / toString.
    expect(Object.getPrototypeOf(evaluations)).toBe(Object.prototype);
    expect(typeof evaluations.hasOwnProperty).toBe("function");
    // Intentional: prove the consumer call site that threw under null-proto.
    // biome-ignore lint/suspicious/noPrototypeBuiltins: pin hasOwnProperty on the map itself
    expect(evaluations.hasOwnProperty("__proto__")).toBe(true);
    expect(Object.keys(evaluations)).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(evaluations, "__proto__")?.value).toEqual({
      variant: false,
      variantName: null,
      reason: "DEFAULT",
      errorCode: null,
      exposureTicket: null,
    });
    expect(String(evaluations)).toBe("[object Object]");
  });

  it("compiled keeps a __proto__ flag key; zod 4.4.3 drops it", () => {
    // Known wire divergence: the same JSON evaluates differently in the SDK
    // than under contracts Zod. Do not "fix" this by dropping the key — the
    // Worker-side silent drop is tracked separately.
    const input = JSON.parse(
      '{"evaluations":{"__proto__":{"variant":false,"variantName":null,"reason":"DEFAULT","errorCode":null,"exposureTicket":null}}}',
    ) as unknown;

    const compiled = EvaluateAllResponseSchema.safeParse(input);
    const zod = ZodEvaluateAllResponseSchema.safeParse(input);
    expect(compiled.success).toBe(true);
    expect(zod.success).toBe(true);
    if (!compiled.success || !zod.success) {
      return;
    }

    expect(Object.keys(compiled.data.evaluations)).toEqual(["__proto__"]);
    expect(Object.keys(zod.data.evaluations)).toEqual([]);
    expect(compiled.data).not.toEqual(zod.data);
  });

  it("compiled rejects a JSON own __proto__ key on strict objects; zod 4.4.3 strips and accepts", () => {
    // assertExactKeys uses Object.keys, which sees a JSON-parsed own
    // "__proto__". Zod's object parse strips it. Fail-loud on our side — pin
    // so the known-divergence list stays complete. (ResolutionDetails is not
    // strict on either side, so it is not part of this divergence.)
    const evaluateInput = JSON.parse('{"variant":true,"__proto__":{"x":1}}') as unknown;
    expect(DataPlaneEvaluateResponseSchema.safeParse(evaluateInput).success).toBe(false);
    expect(ZodDataPlaneEvaluateResponseSchema.safeParse(evaluateInput).success).toBe(true);

    const peekInput = JSON.parse('{"variant":true,"__proto__":{"x":1}}') as unknown;
    expect(PeekEvaluateResponseSchema.safeParse(peekInput).success).toBe(false);
    expect(ZodPeekEvaluateResponseSchema.safeParse(peekInput).success).toBe(true);

    const evaluateAllInput = JSON.parse('{"evaluations":{},"__proto__":{"x":1}}') as unknown;
    expect(EvaluateAllResponseSchema.safeParse(evaluateAllInput).success).toBe(false);
    expect(ZodEvaluateAllResponseSchema.safeParse(evaluateAllInput).success).toBe(true);
  });
});
