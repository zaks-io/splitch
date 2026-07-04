import { FlagSchema, type Flag, type Variant } from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import { validateJsonSchema, type ValidationIssue } from "./flag-definition-schema";

type FlagRow = NonNullable<Awaited<ReturnType<Repository["flags"]["getFlag"]>>>;
type VariantRow = Awaited<ReturnType<Repository["flags"]["listVariants"]>>[number];

export interface CreateVariantInput {
  name: string;
  value: Variant["value"];
  isDefault: boolean;
  description?: string;
}

export async function flagResponse(repo: Repository, appId: string, flag: FlagRow): Promise<Flag> {
  const variants = await repo.flags.listVariants(appScope(appId), flag.id);
  return FlagSchema.parse({
    id: flag.id,
    appId: flag.appId,
    key: flag.key,
    name: flag.name,
    ...(flag.description ? { description: flag.description } : {}),
    schema: parseStoredSchema(flag.schema),
    variants: variants.map(toVariant),
    defaultVariantId: requiredString(flag.defaultVariantId),
    createdAt: flag.createdAt,
    updatedAt: flag.updatedAt,
  });
}

function toVariant(row: VariantRow): Variant {
  return {
    id: row.id,
    name: row.name,
    value: JSON.parse(row.value) as Variant["value"],
    ...(row.description ? { description: row.description } : {}),
  };
}

export function schemaFromBody(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  return value as Record<string, unknown>;
}

export function parseStoredSchema(value: string | null): Record<string, unknown> | null {
  return value ? (JSON.parse(value) as Record<string, unknown>) : null;
}

export function exactlyOneDefaultIssue(
  variants: readonly CreateVariantInput[],
): [string[], string] | null {
  return variants.filter((variant) => variant.isDefault).length === 1
    ? null
    : [["body", "variants"], "exactly one Variant must be default"];
}

export function duplicateVariantNameIssue(
  variants: readonly CreateVariantInput[],
): [string[], string] | null {
  const names = new Set<string>();
  for (const variant of variants) {
    if (names.has(variant.name)) return [["body", "variants"], "Variant names must be unique"];
    names.add(variant.name);
  }
  return null;
}

export function variantSchemaIssues(
  schema: Record<string, unknown> | null,
  variants: readonly CreateVariantInput[],
): ValidationIssue[] {
  return variants.flatMap((variant, index) =>
    validateJsonSchema(schema, variant.value, ["body", "variants", String(index), "value"]),
  );
}

export function pathBodyMismatch(
  body: Record<string, unknown>,
  expected: Record<string, string>,
): [string[], string] | null {
  for (const [key, value] of Object.entries(expected)) {
    if (body[key] !== value) return [["body", key], `${key} must match the path ${key}`];
  }
  return null;
}

function requiredString(value: string | null): string {
  if (!value) throw new Error("flag definition is missing defaultVariantId");
  return value;
}
