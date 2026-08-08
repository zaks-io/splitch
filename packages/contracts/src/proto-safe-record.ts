import { z } from "zod";

/**
 * Zod's `z.record` silently skips a JSON own `"__proto__"` key (prototype-pollution
 * hardening in zod 4.4.3). That is a silent substitution of missing data. Reject the
 * key before the record parser can drop it.
 *
 * Built as `preprocess → record` (ZodTransform in, record out) so OpenAPI unwraps to
 * the record shape instead of blanking to `{}` the way `unknown().pipe(record)` does.
 */

export const OWN_PROTO_KEY = "__proto__";

function rejectOwnProtoKey(input: unknown, ctx: z.RefinementCtx, message: string): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    ctx.addIssue({ code: "custom", message: "must be an object" });
    return;
  }
  if (Object.hasOwn(input, OWN_PROTO_KEY)) {
    ctx.addIssue({
      code: "custom",
      message,
      path: [OWN_PROTO_KEY],
    });
  }
}

export type ProtoSafeRecordSchema<Value extends z.ZodType> = z.ZodPipe<
  z.ZodTransform<Record<string, z.infer<Value>>, unknown>,
  z.ZodRecord<z.ZodString, Value>
>;

export function protoSafeRecord<Value extends z.ZodType>(
  valueSchema: Value,
  message: string,
): ProtoSafeRecordSchema<Value> {
  return z.preprocess(
    (input, ctx) => {
      rejectOwnProtoKey(input, ctx, message);
      if (ctx.issues.length > 0) {
        return z.NEVER;
      }
      return input;
    },
    z.record(z.string(), valueSchema),
  ) as ProtoSafeRecordSchema<Value>;
}
