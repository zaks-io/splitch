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
  const requiredNames = new Set(
    fields.filter((field) => field.required).map((field) => field.name),
  );
  const optionalNames = requiredNames.size === 0 ? optionalExampleFieldNames(fields) : null;
  const example: Record<string, unknown> = {};
  for (const [name, fieldSchema] of Object.entries(schema.shape)) {
    const { required, inner } = unwrapField(fieldSchema as z.ZodTypeAny);
    if (!required && !(optionalNames?.has(name) ?? false)) continue;
    example[name] = exampleValue(inner, name);
  }
  const parsed = schema.safeParse(example);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `request-body-help: derived example failed schema validation` +
        (issue ? ` at ${issue.path.join(".") || "(root)"}: ${issue.message}` : ""),
    );
  }
  return example;
}

export function exampleValue(schema: z.ZodTypeAny, fieldName: string): unknown {
  const { inner } = unwrapField(schema);
  const type = zodDefType(inner);
  switch (type) {
    case "string":
      return exampleString(fieldName);
    case "number":
    case "int":
      return exampleNumber(inner, fieldName);
    case "boolean":
      return true;
    case "null":
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
      return null;
  }
}

function optionalExampleFieldNames(fields: readonly RequestBodyFieldHelp[]): Set<string> {
  const preferred = fields.filter((field) => {
    const label = field.typeLabel;
    if (label.includes("object[]")) return false;
    if (label.startsWith("{ ") && !label.startsWith("{ percentage")) return false;
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

function exampleNumber(schema: z.ZodTypeAny, fieldName: string): number {
  if (fieldName === "percentage" || fieldName === "confidenceLevel") return 50;
  if (fieldName === "priority") return 0;
  return numberFromChecks(schema) ?? 1;
}

function numberFromChecks(schema: z.ZodTypeAny): number | undefined {
  const checks = zodDef(schema).checks as
    | readonly { _zod?: { def?: { check?: string; value?: number } } }[]
    | undefined;
  for (const check of checks ?? []) {
    const def = check._zod?.def;
    if (def?.check === "greater_than" && typeof def.value === "number") return def.value + 1;
    if (def?.check === "less_than" && typeof def.value === "number") {
      return Math.max(0, def.value - 1);
    }
  }
  return undefined;
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
