import { z } from "zod";

/**
 * Zod's `z.record` silently skips a JSON own `"__proto__"` key (prototype-pollution
 * hardening in zod 4.4.3). That is a silent substitution of missing data.
 *
 * Built as `z.record(...).superRefine(...)` so the schema type stays `record`:
 * OpenAPI and CLI request-body help keep the real shape (a transform/pipe would
 * blank or break them). Zod skips `"__proto__"` before refinements run, so parse
 * is gated to make the refusal reachable.
 *
 * The `.superRefine()` is load-bearing on zod 4.4.3, not optional future-proofing.
 * With zero checks, zod snapshots `_zod.run = _zod.parse` at construction; with at
 * least one check it dereferences `_zod.parse` dynamically. The monkey-patched
 * parse is only reachable in the latter case. Deleting the refinement disables
 * the prototype-pollution guard silently while every test still passes.
 */

export const OWN_PROTO_KEY = "__proto__";
export const OWN_PROTO_KEY_MESSAGE = `must not contain a "${OWN_PROTO_KEY}" key`;

function isPlainObject(input: unknown): input is Record<string | symbol, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * Zod skips `"__proto__"` before refinements see the value. Wrap parse so a raw
 * own key is refused. Requires a check on the schema (the `.superRefine()` below):
 * on zod 4.4.3, zero-check schemas snapshot `_zod.run = _zod.parse` at
 * construction, so this monkeypatch would never run.
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
  // Required on zod 4.4.3: puts a check on the schema so `_zod.parse` is
  // dereferenced dynamically. Without it, construction snapshots
  // `_zod.run = _zod.parse` and the monkeypatch in gateOwnProtoKeyInParse is
  // never reached — the guard dies silently.
  const schema = z.record(z.string(), valueSchema).superRefine((data, ctx) => {
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

/**
 * Refuse an own `"__proto__"` key anywhere in a raw parse tree. Use on the
 * request object so a parent `z.object({ body })` wrapper still sees the key
 * before child `z.record` / union members strip it.
 */
export function refuseOwnProtoTreeInParse(schema: z.ZodTypeAny, message: string): void {
  const prev = schema._zod.parse.bind(schema._zod);
  schema._zod.parse = (payload, ctx) => {
    const path = ownProtoPath(payload.value);
    if (path !== null) {
      payload.issues.push({
        code: "custom",
        message,
        path,
        input: payload.value,
        inst: schema,
      });
      return payload;
    }
    return prev(payload, ctx);
  };
}

function ownProtoPath(value: unknown, path: PropertyKey[] = []): PropertyKey[] | null {
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) return ownProtoPathInArray(value, path);
  if (Object.hasOwn(value, OWN_PROTO_KEY)) return [...path, OWN_PROTO_KEY];
  return ownProtoPathInObject(value as Record<string, unknown>, path);
}

function ownProtoPathInArray(value: unknown[], path: PropertyKey[]): PropertyKey[] | null {
  for (const [index, item] of value.entries()) {
    const found = ownProtoPath(item, [...path, index]);
    if (found !== null) return found;
  }
  return null;
}

function ownProtoPathInObject(
  value: Record<string, unknown>,
  path: PropertyKey[],
): PropertyKey[] | null {
  for (const key of Object.keys(value)) {
    const found = ownProtoPath(value[key], [...path, key]);
    if (found !== null) return found;
  }
  return null;
}
