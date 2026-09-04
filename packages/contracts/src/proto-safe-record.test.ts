import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  OWN_PROTO_KEY,
  OWN_PROTO_KEY_MESSAGE,
  protoSafeRecord,
  refuseOwnProtoTreeInParse,
} from "./proto-safe-record";

const TOO_BIG = "n must be at most 10";

/** JSON.parse is the only way to build a real own `"__proto__"` key. */
function withOwnProtoKey(json: string): unknown {
  return JSON.parse(json);
}

/**
 * A guarded schema that also carries a check. `_zod.run` is zod's check runner,
 * so a gate that overwrites it without delegating back to the original `run`
 * silently drops every `.refine()` / `.superRefine()` on the schema.
 */
function guardedWithRefinement() {
  const schema = z.object({ n: z.number() }).superRefine((value, ctx) => {
    if (value.n > 10) ctx.addIssue({ code: "custom", message: TOO_BIG });
  });
  refuseOwnProtoTreeInParse(schema, OWN_PROTO_KEY_MESSAGE);
  return schema;
}

function messages(error: z.ZodError): string[] {
  return error.issues.map((issue) => issue.message);
}

describe("refuseOwnProtoTreeInParse", () => {
  it("keeps running the schema's own refinement at the top level", () => {
    const result = guardedWithRefinement().safeParse({ n: 99 });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(messages(result.error)).toContain(TOO_BIG);
  });

  it("keeps running the schema's own refinement when nested in a parent", () => {
    const parent = z.object({ body: guardedWithRefinement() });

    const result = parent.safeParse({ body: { n: 99 } });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(messages(result.error)).toContain(TOO_BIG);
  });

  it("keeps running the schema's own refinement on the encode direction", () => {
    const result = z.safeEncode(guardedWithRefinement(), { n: 99 });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(messages(result.error)).toContain(TOO_BIG);
  });

  it("still accepts a value that passes both the gate and the refinement", () => {
    expect(guardedWithRefinement().safeParse({ n: 1 })).toEqual({
      success: true,
      data: { n: 1 },
    });
  });

  it("refuses an own __proto__ key at the top level", () => {
    const result = guardedWithRefinement().safeParse(
      withOwnProtoKey('{"n":1,"__proto__":{"polluted":true}}'),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(messages(result.error)).toContain(OWN_PROTO_KEY_MESSAGE);
  });

  it("refuses an own __proto__ key when nested in a parent", () => {
    const parent = z.object({ body: guardedWithRefinement() });

    const result = parent.safeParse(
      withOwnProtoKey('{"body":{"n":1,"__proto__":{"polluted":true}}}'),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(messages(result.error)).toContain(OWN_PROTO_KEY_MESSAGE);
  });

  it("refuses an own __proto__ key on the encode direction", () => {
    const result = z.safeEncode(
      guardedWithRefinement(),
      withOwnProtoKey('{"n":1,"__proto__":{"polluted":true}}') as { n: number },
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(messages(result.error)).toContain(OWN_PROTO_KEY_MESSAGE);
  });

  it("refuses an own __proto__ key on a schema that carries no checks", () => {
    const schema = z.object({ n: z.number() });
    refuseOwnProtoTreeInParse(schema, OWN_PROTO_KEY_MESSAGE);

    const result = schema.safeParse(withOwnProtoKey('{"n":1,"__proto__":{"polluted":true}}'));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(messages(result.error)).toContain(OWN_PROTO_KEY_MESSAGE);
  });
});

describe("protoSafeRecord", () => {
  it("refuses a raw own __proto__ key", () => {
    const schema = protoSafeRecord(z.string(), OWN_PROTO_KEY_MESSAGE);

    const result = schema.safeParse(withOwnProtoKey('{"a":"1","__proto__":{"polluted":"1"}}'));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(messages(result.error)).toContain(OWN_PROTO_KEY_MESSAGE);
  });

  // zod's memoizer restores `_zod.parse` to its construction-time value the first
  // time a benign parse reaches its wrapper. A parse-slot-only gate dies there.
  it("still refuses an own __proto__ key after a benign parse warms zod's memoizer", () => {
    const schema = protoSafeRecord(z.string(), OWN_PROTO_KEY_MESSAGE);

    expect(schema.safeParse({ a: "1" }).success).toBe(true);
    const result = schema.safeParse(withOwnProtoKey('{"a":"1","__proto__":{"polluted":"1"}}'));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(messages(result.error)).toContain(OWN_PROTO_KEY_MESSAGE);
  });

  it("refuses an own __proto__ key when nested inside a parent object", () => {
    const parent = z.object({ meta: protoSafeRecord(z.string(), OWN_PROTO_KEY_MESSAGE) });

    const result = parent.safeParse(
      withOwnProtoKey('{"meta":{"a":"1","__proto__":{"polluted":"1"}}}'),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(messages(result.error)).toContain(OWN_PROTO_KEY_MESSAGE);
  });

  it("keeps the key out of parsed output for a value zod strips silently", () => {
    const schema = protoSafeRecord(z.string(), OWN_PROTO_KEY_MESSAGE);

    const result = schema.safeParse({ a: "1" });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.hasOwn(result.data, OWN_PROTO_KEY)).toBe(false);
  });
});
