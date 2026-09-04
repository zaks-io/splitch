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
 *
 * As of zod 4.5.x both `_zod.parse` and `_zod.run` must be patched, not just
 * `_zod.parse`. Every container schema (`$ZodObject`, `$ZodRecord`, ...) now
 * runs `core.globalConfig.memoizer.attach(inst)` at construction time
 * (node_modules/zod/v4/core/schemas.js, `$ZodRecord`/`$ZodObject` initializers;
 * the wrapper itself lives in node_modules/zod/v4/core/memoizer.js, `attach()`).
 * That memoizer installs a self-unwrapping wrapper on `_zod.run` which, the
 * first time this schema is validated as a *child* of a container (a parent
 * object/record calls `el._zod.run(...)`, never `el._zod.parse(...)` directly —
 * see `$ZodObject`'s own parse loop in schemas.js), detects the schema is not
 * part of a reference cycle and permanently rewrites `inst._zod.parse` back to
 * whatever `_zod.parse` was at *construction* time — silently discarding this
 * module's later monkey-patch. `_zod.parse` called directly (top-level
 * `schema.safeParse(...)`) still worked, so this had to be traced through a
 * schema nested one level down before it reproduced. Patching `_zod.run` to the
 * same gated function as `_zod.parse` removes the memoizer's wrapper from both
 * slots before it can ever install itself, for both `protoSafeRecord()` and
 * `refuseOwnProtoTreeInParse()`.
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
 *
 * Patches `_zod.run` as well as `_zod.parse` (both to the same function): a
 * parent container validates this schema as a child via `_zod.run`, and zod
 * 4.5.x's memoizer overwrites `_zod.run`/`_zod.parse` back to their
 * construction-time values the first time that happens unless both slots
 * already hold this gate. See the module comment above for the exact zod
 * source path.
 */
function gateOwnProtoKeyInParse(schema: z.ZodTypeAny, message: string): void {
  const prev = schema._zod.parse.bind(schema._zod);
  const gated: typeof schema._zod.parse = (payload, ctx) => {
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
  schema._zod.parse = gated;
  schema._zod.run = gated;
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
 *
 * Patches `_zod.run` as well as `_zod.parse`, same reason as
 * `gateOwnProtoKeyInParse` above: this schema is itself nested as a child
 * whenever a route wrapper does `z.object({ body: schema })`, so it has to
 * survive being invoked through `_zod.run`, not just direct `.safeParse()`.
 */
export function refuseOwnProtoTreeInParse(schema: z.ZodTypeAny, message: string): void {
  const prev = schema._zod.parse.bind(schema._zod);
  const gated: typeof schema._zod.parse = (payload, ctx) => {
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
  schema._zod.parse = gated;
  schema._zod.run = gated;
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
