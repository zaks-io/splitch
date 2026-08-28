import { z } from "zod";
import { DraftAllocationSchema } from "./draft-allocation";
import { WriteVariantValueSchema } from "./write-persisted-schemas";

export interface RequestBodyFieldHelp {
  readonly name: string;
  readonly required: boolean;
  readonly typeLabel: string;
  readonly defaultValue?: unknown;
}

const MAX_TYPE_DEPTH = 16;

export function describeObjectFields(schema: z.ZodObject): RequestBodyFieldHelp[] {
  return Object.entries(schema.shape).map(([name, fieldSchema]) => {
    const { required, defaultValue, nullable, inner } = unwrapField(fieldSchema as z.ZodTypeAny);
    const label = typeLabel(inner);
    return {
      name,
      required,
      typeLabel: nullable ? `${label} | null` : label,
      ...(defaultValue !== undefined ? { defaultValue } : {}),
    };
  });
}

export function unwrapToObject(schema: z.ZodTypeAny): z.ZodObject | undefined {
  const { inner } = unwrapField(schema);
  return inner instanceof z.ZodObject ? inner : undefined;
}

export function unwrapField(schema: z.ZodTypeAny): {
  required: boolean;
  nullable: boolean;
  defaultValue?: unknown;
  inner: z.ZodTypeAny;
} {
  let current = schema;
  let optional = false;
  let nullable = false;
  let defaultValue: unknown;
  for (let guard = 0; guard < MAX_TYPE_DEPTH; guard += 1) {
    const step = unwrapOne(current);
    if (!step) break;
    if (step.optional) optional = true;
    if (step.nullable) nullable = true;
    if (step.defaultValue !== undefined) defaultValue = step.defaultValue;
    current = step.inner;
  }
  return {
    required: !optional,
    nullable,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    inner: current,
  };
}

function unwrapOne(
  schema: z.ZodTypeAny,
): { inner: z.ZodTypeAny; optional?: true; nullable?: true; defaultValue?: unknown } | undefined {
  const type = zodDefType(schema);
  if (type === "optional") {
    return { optional: true, inner: (schema as z.ZodOptional).unwrap() as z.ZodTypeAny };
  }
  if (type === "default") {
    const def = (schema as z.ZodDefault).def;
    const defaultValue =
      typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue;
    return {
      optional: true,
      defaultValue,
      inner: (schema as z.ZodDefault).unwrap() as z.ZodTypeAny,
    };
  }
  if (type === "nullable") {
    return { nullable: true, inner: (schema as z.ZodNullable).unwrap() as z.ZodTypeAny };
  }
  if (type === "pipe") {
    const pipeIn = zodDef(schema).in;
    return pipeIn ? { inner: pipeIn as z.ZodTypeAny } : undefined;
  }
  return undefined;
}

export function zodDefType(schema: z.ZodTypeAny): string | undefined {
  const type = zodDef(schema).type;
  return typeof type === "string" ? type : undefined;
}

/** Read Zod v4 `def` bags without fighting the opaque `$ZodTypeDef` type. */
export function zodDef(schema: z.ZodTypeAny): Record<string, unknown> {
  return schema.def as unknown as Record<string, unknown>;
}

export function zodElement(schema: z.ZodTypeAny): z.ZodTypeAny {
  return zodDef(schema).element as z.ZodTypeAny;
}

export function zodValueType(schema: z.ZodTypeAny): z.ZodTypeAny {
  return zodDef(schema).valueType as z.ZodTypeAny;
}

export function zodOptions(schema: z.ZodTypeAny): z.ZodTypeAny[] {
  return (zodDef(schema).options as z.ZodTypeAny[] | undefined) ?? [];
}

export function zodLiteralValues(schema: z.ZodTypeAny): unknown[] {
  return (zodDef(schema).values as unknown[] | undefined) ?? [];
}

function typeLabel(schema: z.ZodTypeAny, depth = 0): string {
  if (schema === WriteVariantValueSchema) {
    return "boolean | string | number | Record<string, unknown>";
  }
  if (depth >= MAX_TYPE_DEPTH) {
    throw new Error(
      `request-body-help: type label exceeded max depth ${MAX_TYPE_DEPTH} (self-referential schema?)`,
    );
  }
  const type = zodDefType(schema);
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "int":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "unknown":
    case "any":
      // Present in leaf schemas for JSON-ish values (condition value, Variant value).
      return type;
    case "literal": {
      return (
        zodLiteralValues(schema)
          .map((value) => JSON.stringify(value))
          .join(" | ") || "literal"
      );
    }
    case "enum": {
      const options = (schema as z.ZodEnum).options as readonly unknown[];
      return `string (${options.map((value) => JSON.stringify(value)).join(" | ")})`;
    }
    case "array": {
      const elementSchema = zodElement(schema);
      const element = typeLabel(elementSchema, depth + 1);
      const elementType = zodDefType(unwrapField(elementSchema).inner);
      const needsParens = elementType === "union" || elementType === "xor";
      return `${needsParens ? `(${element})` : element}[]`;
    }
    case "record": {
      // Identity check — rename the field, keep the schema, label stays.
      if (schema === DraftAllocationSchema) {
        return `Record<Variant name, ${typeLabel(zodValueType(schema), depth + 1)}>`;
      }
      return `Record<string, ${typeLabel(zodValueType(schema), depth + 1)}>`;
    }
    case "lazy":
      return "closed JSON Schema";
    case "object":
      return objectTypeLabel(schema as z.ZodObject, depth);
    case "union":
    case "xor": {
      return zodOptions(schema)
        .map((option) => typeLabel(option, depth + 1))
        .join(" | ");
    }
    case "nullable":
      return `${typeLabel((schema as z.ZodNullable).unwrap() as z.ZodTypeAny, depth + 1)} | null`;
    case "optional":
    case "default":
      return typeLabel(unwrapField(schema).inner, depth + 1);
    default:
      throw new Error(
        `request-body-help: unsupported Zod type "${type ?? "undefined"}" for help rendering`,
      );
  }
}

/** Expand nested objects fully so enums and shapes stay discoverable at any depth. */
function objectTypeLabel(schema: z.ZodObject, depth: number): string {
  const parts = Object.entries(schema.shape).map(([name, fieldSchema]) => {
    const { required, nullable, inner } = unwrapField(fieldSchema as z.ZodTypeAny);
    const nested = typeLabel(inner, depth + 1);
    const withNull = nullable ? `${nested} | null` : nested;
    return `${name}${required ? "" : "?"}: ${withNull}`;
  });
  return `{ ${parts.join("; ")} }`;
}
