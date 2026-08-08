import { describe, expect, it } from "vitest";
import {
  DataPlaneEvaluateResponseSchema as ZodDataPlaneEvaluateResponseSchema,
  EvaluateAllResponseSchema as ZodEvaluateAllResponseSchema,
  PeekEvaluateResponseSchema as ZodPeekEvaluateResponseSchema,
  ResolutionDetailsSchema as ZodResolutionDetailsSchema,
} from "../../contracts/src/sdk-data-plane-surface";
import {
  DataPlaneEvaluateResponseSchema,
  EvaluateAllResponseSchema,
  PeekEvaluateResponseSchema,
  ResolutionDetailsSchema,
} from "./generated/contract-surface.js";

type ParseResult =
  | { success: true; data: unknown }
  | { success: false; error?: { message?: string } };
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

function evaluateAllEntry(overrides: Record<string, unknown>) {
  return {
    evaluations: {
      flag: {
        variant: true,
        variantName: "on",
        reason: "DEFAULT",
        errorCode: null,
        exposureTicket: null,
        ...overrides,
      },
    },
  };
}

describe("contract-surface wrong-type fixtures", () => {
  it("wrong scalar types match Zod rejection on all four schemas", () => {
    // Hand-rolled type guards replace zod here. Without these rows, six of them
    // can be deleted (`if (false)` / drop `!Array.isArray`) and the suite stays
    // green while the mirror quietly accepts Worker lies about declared types.
    for (const row of [
      { input: { variant: [1, 2] }, ok: false },
      { input: { variant: true }, ok: true },
    ]) {
      expectParity(
        DataPlaneEvaluateResponseSchema,
        ZodDataPlaneEvaluateResponseSchema,
        row.input,
        row.ok,
      );
      expectParity(PeekEvaluateResponseSchema, ZodPeekEvaluateResponseSchema, row.input, row.ok);
    }
    for (const row of [
      { input: { value: [1], variantName: "on", reason: "SPLIT" }, ok: false },
      { input: { value: true, variantName: 123, reason: "SPLIT" }, ok: false },
      { input: { value: true, variantName: "on", reason: 1 }, ok: false },
      {
        input: { value: true, variantName: "on", reason: "TARGETING_MATCH", ruleId: 123 },
        ok: false,
      },
      { input: { value: false, variantName: null, reason: "ERROR", errorCode: 1 }, ok: false },
      {
        input: {
          value: false,
          variantName: null,
          reason: "ERROR",
          errorCode: "FLAG_NOT_FOUND",
          errorMessage: 123,
        },
        ok: false,
      },
    ]) {
      expectParity(ResolutionDetailsSchema, ZodResolutionDetailsSchema, row.input, row.ok);
    }
    for (const input of [
      { evaluations: [] },
      evaluateAllEntry({ variant: [1] }),
      evaluateAllEntry({ variantName: 123 }),
      evaluateAllEntry({ reason: 1 }),
      evaluateAllEntry({ variant: null, variantName: null, reason: "ERROR", errorCode: 1 }),
      evaluateAllEntry({ reason: "SPLIT", exposureTicket: 123 }),
      { evaluations: { flag: [] } },
    ]) {
      expectParity(EvaluateAllResponseSchema, ZodEvaluateAllResponseSchema, input, false);
    }
  });

  it("root arrays are rejected (shared isPlainObject !Array.isArray)", () => {
    // One clause guards every schema's root. A single edit drifts all four.
    expectParity(DataPlaneEvaluateResponseSchema, ZodDataPlaneEvaluateResponseSchema, [], false);
    expectParity(PeekEvaluateResponseSchema, ZodPeekEvaluateResponseSchema, [], false);
    expectParity(ResolutionDetailsSchema, ZodResolutionDetailsSchema, [], false);
    expectParity(EvaluateAllResponseSchema, ZodEvaluateAllResponseSchema, [], false);
  });

  it("requireKeys fails with a missing-required-key diagnostic", () => {
    // Without this pin, requireKeys can be neutered and every required field is
    // still rejected later — only the message changes. Keep the clearer one.
    const result = DataPlaneEvaluateResponseSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error?.message).toBe(
        'DataPlaneEvaluateResponse: missing required key "variant"',
      );
    }
  });
});
