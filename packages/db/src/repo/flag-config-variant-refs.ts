import { and, eq, sql } from "drizzle-orm";
import { flagConfigs, flags, type targetingRules, variants } from "../schema/index";
import type { Db } from "./client";
import type { EnvScope } from "./scope";
import { hasUniqueViolationMessage, uniqueViolationMessage } from "./unique-violation";

type TargetingRuleWrite = Omit<
  typeof targetingRules.$inferInsert,
  "appId" | "environmentId" | "flagId"
>;

/**
 * SQLite reports a composite unique-index violation by COLUMN LIST, not by
 * index name. Matching the whole constraint string keeps this from swallowing
 * a different fault on the same columns.
 */
const TARGETING_RULE_ID_UNIQUE_VIOLATION =
  "UNIQUE constraint failed: targeting_rules.app_id, targeting_rules.environment_id, targeting_rules.flag_id, targeting_rules.id";
const TARGETING_RULE_ID_UNIQUE_MESSAGE = uniqueViolationMessage(TARGETING_RULE_ID_UNIQUE_VIOLATION);

/**
 * Fail-loud probes that ride in the same batch as the rule rewrite. A
 * concurrent Variant delete that commits first makes `json('')` abort the
 * transaction, so the delete of the previous rules cannot land without the
 * replacements. `flag_configs` is the FROM so a missing Variant still produces
 * a row (and therefore evaluates ELSE) instead of a silent zero-row SELECT.
 */
export function referencedVariantMustExist(
  db: Db,
  scope: EnvScope,
  flagId: string,
  rows: TargetingRuleWrite[],
) {
  return referencedVariantIds(rows).map((variantId) =>
    db
      .select({
        ok: sql<number>`CASE WHEN EXISTS (
          SELECT 1 FROM variants
          INNER JOIN flags ON flags.id = variants.flag_id
          WHERE variants.id = ${variantId}
            AND flags.app_id = ${scope.appId}
            AND variants.flag_id = ${flagId}
        ) THEN 1 ELSE json('') END`,
      })
      .from(flagConfigs)
      .where(
        and(
          eq(flagConfigs.appId, scope.appId),
          eq(flagConfigs.environmentId, scope.environmentId),
          eq(flagConfigs.flagId, flagId),
        ),
      )
      .limit(1),
  );
}

export async function missingReferencedVariants(
  db: Db,
  scope: EnvScope,
  flagId: string,
  rows: TargetingRuleWrite[],
): Promise<string[]> {
  const missing: string[] = [];
  for (const variantId of referencedVariantIds(rows)) {
    const found = await db
      .select({ id: variants.id })
      .from(variants)
      .innerJoin(flags, eq(flags.id, variants.flagId))
      .where(
        and(eq(variants.id, variantId), eq(flags.appId, scope.appId), eq(variants.flagId, flagId)),
      )
      .limit(1);
    if (!found[0]) missing.push(variantId);
  }
  return missing;
}

export function targetingRuleWriteFailure(
  cause: unknown,
  referencedIds: readonly string[],
):
  | { ok: false; reason: "id_conflict" }
  | { ok: false; reason: "missing_variant"; missingVariantIds: string[] } {
  if (hasUniqueViolationMessage(cause, TARGETING_RULE_ID_UNIQUE_MESSAGE)) {
    return { ok: false, reason: "id_conflict" };
  }
  if (referencedIds.length > 0 && isFailLoudJsonProbe(cause)) {
    return { ok: false, reason: "missing_variant", missingVariantIds: [...referencedIds] };
  }
  throw cause;
}

function referencedVariantIds(rows: TargetingRuleWrite[]): string[] {
  return [
    ...new Set(rows.flatMap((row) => (typeof row.variantId === "string" ? [row.variantId] : []))),
  ];
}

function isFailLoudJsonProbe(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (/malformed JSON/iu.test(message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
