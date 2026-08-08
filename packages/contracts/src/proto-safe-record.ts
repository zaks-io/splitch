import { z } from "zod";

/**
 * Zod's `z.record` silently skips a JSON own `"__proto__"` key (prototype-pollution
 * hardening in zod 4.4.3). That is a silent substitution of missing data.
 *
 * Built as `z.record(...).superRefine(...)` so the schema type stays `record`:
 * OpenAPI and CLI request-body help keep the real shape (a transform/pipe would
 * blank or break them). Zod skips `"__proto__"` before refinements run, so parse
 * is gated to make the refusal reachable.
 */

export const OWN_PROTO_KEY = "__proto__";

function isPlainObject(input: unknown): input is Record<string | symbol, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * Zod skips `"__proto__"` before `.check` / `.superRefine` see the value. Wrap
 * parse so a raw own key is refused with the same issue shape as a refinement.
 */
function gateOwnProtoKeyInParse(schema: z.ZodTypeAny, message: string): void {
  const prev = schema._zod.parse.bind(schema._zod);
  schema._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (isPlainObject(input) && Object.hasOwn(input, OWN_PROTO_KEY)) {
      payload.issues.push({
        code: "custom",
        message,
        path: [OWN_PROTO_KEY],
        input,
        inst: schema,
      });
      return payload;
    }
    return prev(payload, ctx);
  };
}

export type ProtoSafeRecordSchema<Value extends z.ZodType> = z.ZodRecord<z.ZodString, Value>;

export function protoSafeRecord<Value extends z.ZodType>(
  valueSchema: Value,
  message: string,
): ProtoSafeRecordSchema<Value> {
  const schema = z.record(z.string(), valueSchema).superRefine((data, ctx) => {
    // If a future Zod stops skipping `"__proto__"`, refuse it here too.
    if (Object.hasOwn(data, OWN_PROTO_KEY)) {
      ctx.addIssue({
        code: "custom",
        message,
        path: [OWN_PROTO_KEY],
      });
    }
  });
  gateOwnProtoKeyInParse(schema, message);
  return schema as ProtoSafeRecordSchema<Value>;
}
