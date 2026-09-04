import { describe, expect, it } from "vitest";
import {
  DataPlaneEvaluateResponseSchema as ZodDataPlaneEvaluateResponseSchema,
  EvaluateAllResponseSchema as ZodEvaluateAllResponseSchema,
  PeekEvaluateResponseSchema as ZodPeekEvaluateResponseSchema,
} from "../../contracts/src/sdk-data-plane-surface";
import {
  DataPlaneEvaluateResponseSchema,
  EvaluateAllResponseSchema,
  PeekEvaluateResponseSchema,
} from "./generated/contract-surface.js";

type ParseResult = { success: true; data: unknown } | { success: false; error?: unknown };
type AnySchema = { safeParse: (input: unknown) => ParseResult };

// zod 4.5.1 fixed a `.strict()` blind spot: on zod 4.4.3, `Reflect.ownKeys`
// iteration skipped an own "__proto__" key entirely, so `.strict()` never saw
// it as unrecognized and let it through silently. zod 4.5.1 now reports
// "__proto__" as an `unrecognized_keys` issue like any other extra key
// (verified directly against node_modules/zod@4.5.1: `.object({}).strict()
// .safeParse({ __proto__: {...} })` returns `{ code: "unrecognized_keys",
// keys: ["__proto__"] }`). The compiled (hand-rolled) validator never checked
// for unrecognized keys at all, so it silently strips the sibling key on both
// zod versions — that half is unaffected by the bump.
function expectProtoSiblingStrippedByCompiledButRefusedByZod(
  compiled: AnySchema,
  zod: AnySchema,
  input: unknown,
  strippedData: unknown,
) {
  const compiledResult = compiled.safeParse(input);
  const zodResult = zod.safeParse(input);
  expect(compiledResult.success).toBe(true);
  expect(zodResult.success).toBe(false);
  if (compiledResult.success) {
    expect(compiledResult.data).toEqual(strippedData);
  }
  if (!zodResult.success) {
    expect(zodResult.error.issues).toContainEqual(
      expect.objectContaining({ code: "unrecognized_keys", keys: ["__proto__"] }),
    );
  }
}

describe("contract-surface __proto__ parity", () => {
  it("both refuse an own __proto__ Flag Key with the contract message", () => {
    const input = JSON.parse(
      '{"evaluations":{"__proto__":{"variant":false,"variantName":null,"reason":"DEFAULT","errorCode":null,"exposureIdentity":null,"exposureTicket":null}}}',
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

  it("compiled strips a JSON own __proto__ sibling key; zod 4.5.1 now refuses it", () => {
    // Sibling __proto__ is not a flag key. Pin all three strict response
    // schemas — this is the SPL-353 surface — to the new, safer zod behavior
    // (see expectProtoSiblingStrippedByCompiledButRefusedByZod above).
    expectProtoSiblingStrippedByCompiledButRefusedByZod(
      DataPlaneEvaluateResponseSchema,
      ZodDataPlaneEvaluateResponseSchema,
      JSON.parse('{"variant":true,"__proto__":{"x":1}}'),
      { variant: true },
    );

    expectProtoSiblingStrippedByCompiledButRefusedByZod(
      PeekEvaluateResponseSchema,
      ZodPeekEvaluateResponseSchema,
      JSON.parse('{"variant":true,"__proto__":{"x":1}}'),
      { variant: true },
    );

    expectProtoSiblingStrippedByCompiledButRefusedByZod(
      EvaluateAllResponseSchema,
      ZodEvaluateAllResponseSchema,
      JSON.parse('{"evaluations":{},"__proto__":{"x":1}}'),
      { evaluations: {} },
    );
  });
});
