import type { z } from "zod";
import {
  describeObjectFields,
  type RequestBodyFieldHelp,
  unwrapField,
  zodDef,
  zodDefType,
  zodElement,
  zodLiteralValues,
  zodOptions,
  zodValueType,
} from "./request-body-help-unwrap";

/** Build one concrete request-body example for help (no secrets). */
export function exampleForObject(
  schema: z.ZodObject,
  fields: readonly RequestBodyFieldHelp[],
): Record<string, unknown> {
  const example = buildExampleCandidate(schema, fields);
  assertExampleParses(schema, example);
  return example;
}

function buildExampleCandidate(
  schema: z.ZodObject,
  fields: readonly RequestBodyFieldHelp[],
): Record<string, unknown> {
  const requiredNames = new Set(
    fields.filter((field) => field.required).map((field) => field.name),
  );
  // Include shallow optionals when the body is all-optional, or when the only
  // required field is idempotency_key (otherwise Policy-gated patches look like no-ops).
  const includeOptionals =
    requiredNames.size === 0 || (requiredNames.size === 1 && requiredNames.has("idempotency_key"));
  const optionalNames = includeOptionals ? optionalExampleFieldNames(fields) : null;
  const byName = new Map(fields.map((field) => [field.name, field]));
  const example: Record<string, unknown> = {};
  for (const [name, fieldSchema] of Object.entries(schema.shape)) {
    const { required, inner } = unwrapField(fieldSchema as z.ZodTypeAny);
    if (!required && !(optionalNames?.has(name) ?? false)) continue;
    const help = byName.get(name);
    example[name] =
      help?.defaultValue !== undefined ? help.defaultValue : exampleValue(inner, name);
  }
  return example;
}

function assertExampleParses(schema: z.ZodObject, example: Record<string, unknown>): void {
  const parsed = schema.safeParse(example);
  if (parsed.success) return;
  const issue = parsed.error.issues[0];
  throw new Error(
    `request-body-help: derived example failed schema validation` +
      (issue ? ` at ${issue.path.join(".") || "(root)"}: ${issue.message}` : ""),
  );
}

function exampleValue(schema: z.ZodTypeAny, fieldName: string): unknown {
  const { inner } = unwrapField(schema);
  const type = zodDefType(inner);
  switch (type) {
    case "string":
      return exampleString(fieldName);
    case "number":
    case "int":
      return exampleNumber(inner);
    case "boolean":
      return true;
    case "null":
      return null;
    case "unknown":
    case "any":
      return null;
    case "literal":
      return literalExample(inner);
    case "enum":
      return enumExample(inner);
    case "array":
      return arrayExample(inner, fieldName);
    case "record":
      return recordExample(inner);
    case "object":
      return exampleForObject(inner as z.ZodObject, describeObjectFields(inner as z.ZodObject));
    case "union":
    case "xor":
      return unionExample(inner, fieldName);
    case "nullable":
      return exampleValue((inner as z.ZodNullable).unwrap() as z.ZodTypeAny, fieldName);
    default:
      throw new Error(
        `request-body-help: unsupported Zod type "${type ?? "undefined"}" for example generation`,
      );
  }
}

/**
 * Prefer shallow scalars, enums, arrays of scalars, and records. Skip nested
 * object shapes / object arrays so all-optional Examples stay writable.
 */
function optionalExampleFieldNames(fields: readonly RequestBodyFieldHelp[]): Set<string> {
  const preferred = fields.filter((field) => {
    if (field.name === "idempotency_key") return false;
    const label = field.typeLabel;
    if (label.startsWith("{ ")) return false;
    if (label.includes("}[]")) return false;
    return true;
  });
  const names = preferred.length > 0 ? preferred : fields.slice(0, 1);
  return new Set(names.map((field) => field.name));
}

const EXAMPLE_STRINGS: Readonly<Record<string, string>> = {
  idempotency_key: "idem-1",
  targetingKey: "userId",
  targetingKeyType: "user",
  attribute: "country",
  operator: "eq",
  value: "US",
  key: "checkout",
  name: "Checkout",
  slug: "acme",
  reason: "approved",
  originAllowlist: "https://app.example.com",
};

function exampleString(fieldName: string): string {
  const known = EXAMPLE_STRINGS[fieldName];
  if (known) return known;
  const lower = fieldName.toLowerCase();
  if (lower.includes("origin") || lower.includes("allowlist") || lower.endsWith("url")) {
    return "https://app.example.com";
  }
  if (fieldName.endsWith("Id") || fieldName === "id") {
    return `${fieldName.replace(/Id$/, "") || "id"}_1`;
  }
  if (fieldName.endsWith("Ids")) return `${fieldName.slice(0, -3)}_1`;
  return fieldName;
}

/** Prefer schema bounds; never special-case field names (SPL-309 review). */
function exampleNumber(schema: z.ZodTypeAny): number {
  return numberFromChecks(schema) ?? 1;
}

function numberFromChecks(schema: z.ZodTypeAny): number | undefined {
  const { min, max } = numberBounds(schema);
  if (min !== undefined && max !== undefined) return (min + max) / 2;
  if (min !== undefined) return min;
  if (max !== undefined) return max;
  return undefined;
}

function numberBounds(schema: z.ZodTypeAny): { min?: number; max?: number } {
  const bounds = readNumberBounds(schema);
  const minBound = bounds.find((bound) => bound.kind === "min");
  const maxBound = bounds.find((bound) => bound.kind === "max");
  return {
    ...(minBound ? { min: minBound.inclusive ? minBound.value : minBound.value + 1 } : {}),
    ...(maxBound ? { max: maxBound.inclusive ? maxBound.value : maxBound.value - 1 } : {}),
  };
}

function readNumberBounds(
  schema: z.ZodTypeAny,
): readonly { kind: "min" | "max"; value: number; inclusive: boolean }[] {
  const checks = zodDef(schema).checks as
    | readonly { _zod?: { def?: { check?: string; value?: number; inclusive?: boolean } } }[]
    | undefined;
  const bounds: { kind: "min" | "max"; value: number; inclusive: boolean }[] = [];
  for (const check of checks ?? []) {
    const def = check._zod?.def;
    if (typeof def?.value !== "number") continue;
    if (def.check === "greater_than") {
      bounds.push({ kind: "min", value: def.value, inclusive: def.inclusive !== false });
    }
    if (def.check === "less_than") {
      bounds.push({ kind: "max", value: def.value, inclusive: def.inclusive !== false });
    }
  }
  return bounds;
}

function arrayMin(schema: z.ZodTypeAny): number {
  const checks = zodDef(schema).checks as
    | readonly { _zod?: { def?: { check?: string; minimum?: number } } }[]
    | undefined;
  for (const check of checks ?? []) {
    const def = check._zod?.def;
    if (def?.check === "min_length" && typeof def.minimum === "number") return def.minimum;
  }
  return 0;
}

function literalExample(schema: z.ZodTypeAny): unknown {
  return zodLiteralValues(schema)[0] ?? null;
}

function enumExample(schema: z.ZodTypeAny): unknown {
  const options = (schema as z.ZodEnum).options as readonly unknown[];
  return options[0] ?? null;
}

function arrayExample(schema: z.ZodTypeAny, fieldName: string): unknown[] {
  const element = zodElement(schema);
  const elementInner = unwrapField(element).inner;
  if (arrayMin(schema) > 0 || zodDefType(elementInner) === "object") {
    return [exampleValue(element, fieldName)];
  }
  return [];
}

function recordExample(schema: z.ZodTypeAny): Record<string, unknown> {
  const valueType = zodValueType(schema);
  return {
    control: exampleValue(valueType, "control"),
    treatment: exampleValue(valueType, "treatment"),
  };
}

function unionExample(schema: z.ZodTypeAny, fieldName: string): unknown {
  const ranked = [...zodOptions(schema)].sort(
    (left, right) =>
      unionExampleRank(unwrapField(left).inner) - unionExampleRank(unwrapField(right).inner),
  );
  const first = ranked[0];
  return first === undefined ? null : exampleValue(first, fieldName);
}

function unionExampleRank(schema: z.ZodTypeAny): number {
  const type = zodDefType(schema);
  if (type === "union" || type === "xor") {
    return Math.min(
      ...zodOptions(schema).map((option) => unionExampleRank(unwrapField(option).inner)),
    );
  }
  switch (type) {
    case "string":
    case "enum":
    case "literal":
      return 0;
    case "number":
    case "int":
      return 1;
    case "object":
    case "record":
      return 2;
    case "boolean":
      return 3;
    case "array":
      return 4;
    case "null":
      return 5;
    default:
      return 6;
  }
}
