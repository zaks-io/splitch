import {
  type Flag,
  FlagSchema,
  PercentageRolloutSchema,
  type ValidationIssue,
  type Variant,
  validateJsonSchema,
} from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";

type FlagRow = NonNullable<Awaited<ReturnType<Repository["flags"]["getFlag"]>>>;
type VariantRow = Awaited<ReturnType<Repository["flags"]["listVariants"]>>[number];
type FlagConfigRow = NonNullable<Awaited<ReturnType<Repository["flags"]["getFlagConfig"]>>>;

export interface CreateVariantInput {
  name: string;
  value: Variant["value"];
  isDefault: boolean;
  description?: string;
}

export async function flagResponse(repo: Repository, appId: string, flag: FlagRow): Promise<Flag> {
  return flagFrom(flag, await repo.flags.listVariants(appScope(appId), flag.id));
}

/**
 * The wire Flag, from rows the caller already holds.
 *
 * Split from `flagResponse` so a LIST can read every Variant catalog in one
 * query and still produce identical items: the single-Flag path keeps its own
 * read, and neither path gets its own copy of the mapping.
 */
export function flagFrom(flag: FlagRow, variants: readonly VariantRow[]): Flag {
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

export function flagWithConfigurationFrom(
  flag: FlagRow,
  variants: readonly VariantRow[],
  config: FlagConfigRow,
  targetingRuleRolloutPercentages: readonly number[],
  experiment: { id: string; name: string } | null,
) {
  const definition = flagFrom(flag, variants);
  const defaultVariant = variants.find((variant) => variant.id === config.defaultVariantId);
  if (!defaultVariant) {
    throw new Error(
      `flag list: Flag Configuration ${config.id} references missing Default Variant ${String(config.defaultVariantId)}`,
    );
  }
  return {
    ...definition,
    flagConfiguration: {
      enabled: config.enabled,
      rollout: storedRolloutPercentage(config.rollout),
      defaultVariant: defaultVariant.name,
      availableVariantNames: JSON.parse(config.availableVariantNames) as string[],
      targetingRuleRolloutPercentages,
      experiment,
    },
  };
}

function storedRolloutPercentage(value: string | null): number | null {
  if (value === null) return null;
  return PercentageRolloutSchema.parse(JSON.parse(value)).percentage;
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
