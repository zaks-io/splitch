import { z } from "zod";

/**
 * Zod's `z.record` silently skips a JSON own `"__proto__"` key (prototype-pollution
 * hardening in zod 4.4.3). That is a silent substitution of missing data.
 *
 * Built as `z.record(...)` so the schema type stays `record`: OpenAPI and CLI
 * request-body help keep the real shape (a transform/pipe would blank or break
 * them). Zod drops `"__proto__"` before refinements run, so the refusal is only
 * reachable from inside the parse path.
 *
 * Both `_zod.parse` and `_zod.run` carry the gate. `_zod.run` is the slot callers
 * actually read: top-level `schema.safeParse(...)` calls `schema._zod.run(...)`
 * (node_modules/zod/v4/core/parse.js, `_safeParse`), and a parent container
 * validates a child through `el._zod.run(...)`, never `el._zod.parse(...)`.
 *
 * Patching `_zod.parse` alone does not survive. Every container schema runs
 * `core.globalConfig.memoizer.attach(inst)` at construction
 * (node_modules/zod/v4/core/schemas.js, `$ZodObject`/`$ZodRecord` initializers;
 * the wrapper lives in node_modules/zod/v4/core/memoizer.js, `attach()`). Its
 * deferred has already replaced `_zod.parse` before this module ever sees the
 * schema, and the first time that wrapper runs it discovers the schema is not
 * part of a reference cycle and permanently restores `inst._zod.parse` to its
 * construction-time value, dropping this module's patch. Measured on zod 4.5.1:
 * with only `_zod.parse` patched, `refuseOwnProtoTreeInParse()` was dead from the
 * first call at any depth, and `protoSafeRecord()` refused a raw `"__proto__"`
 * only until any one benign parse warmed the memoizer, then went dead too. The
 * `_zod.run` patch survives because the memoizer restores `_zod.run` only while
 * that slot still holds the memoizer's own wrapper, which it no longer does.
 *
 * The two wrappers must not share a delegate. `_zod.run` is also zod's check
 * runner (schemas.js, the `if (checks.length)` branch): it is the only thing that
 * executes `.refine()` / `.superRefine()` / `.check()`, and the only thing that
 * honours `ctx.skipChecks` and `ctx.direction === "backward"`. A `run` wrapper
 * that fell through to the captured `parse` would silently skip every check on
 * the schema. Each wrapper therefore delegates to the original it replaced.
 */

export const OWN_PROTO_KEY = "__proto__";
export const OWN_PROTO_KEY_MESSAGE = `must not contain a "${OWN_PROTO_KEY}" key`;

type ParseFn = z.ZodTypeAny["_zod"]["parse"];
type Payload = Parameters<ParseFn>[0];

function isPlainObject(input: unknown): input is Record<string | symbol, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * Install one gate across both parse slots, each delegating to the original it
 * replaced so `_zod.run` keeps running the schema's checks. `refuse` reports
 * whether it pushed a refusal issue; it runs on the backward/encode direction
 * too, where failing closed is what we want.
 */
function installProtoGate(schema: z.ZodTypeAny, refuse: (payload: Payload) => boolean): void {
  const originalParse = schema._zod.parse.bind(schema._zod);
  const originalRun = schema._zod.run.bind(schema._zod);
  schema._zod.parse = (payload, ctx) => (refuse(payload) ? payload : originalParse(payload, ctx));
  schema._zod.run = (payload, ctx) => (refuse(payload) ? payload : originalRun(payload, ctx));
}

/** Refuse a raw own `"__proto__"` key on the value this schema is handed. */
function gateOwnProtoKeyInParse(schema: z.ZodTypeAny, message: string): void {
  installProtoGate(schema, (payload) => {
    const input = payload.value;
    if (!isPlainObject(input) || !Object.hasOwn(input, OWN_PROTO_KEY)) return false;
    payload.issues.push({
      code: "custom",
      message,
      path: [OWN_PROTO_KEY],
      input,
      inst: schema,
    });
    return true;
  });
}

export type ProtoSafeRecordSchema<Value extends z.ZodType> = z.ZodRecord<z.ZodString, Value>;

export function protoSafeRecord<Value extends z.ZodType>(
  valueSchema: Value,
  message: string,
): ProtoSafeRecordSchema<Value> {
  // Not the guard. Zod drops `"__proto__"` before checks run, so `data` never
  // carries the key and this refinement cannot fire (measured on zod 4.5.1).
  // `gateOwnProtoKeyInParse` is what refuses the key, on both parse slots and
  // regardless of whether the schema carries checks. The refinement stays
  // because packages/sdk/scripts/contract-surface-refine-inventory.ts enumerates
  // every refinement in the contracts graph and the SDK parity test asserts the
  // compiled surface reproduces it: dropping it is a contract-surface change.
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
 * Gates both parse slots for the reason in the module comment: this schema is
 * itself nested as a child whenever a route wrapper does
 * `z.object({ body: schema })`, so it has to survive being invoked through
 * `_zod.run`, not just direct `.safeParse()`.
 */
export function refuseOwnProtoTreeInParse(schema: z.ZodTypeAny, message: string): void {
  installProtoGate(schema, (payload) => {
    const path = ownProtoPath(payload.value);
    if (path === null) return false;
    payload.issues.push({
      code: "custom",
      message,
      path,
      input: payload.value,
      inst: schema,
    });
    return true;
  });
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
