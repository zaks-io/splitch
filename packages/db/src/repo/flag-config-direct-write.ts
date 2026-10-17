import { and, eq, sql } from "drizzle-orm";
import { flagConfigs, targetingRules } from "../schema/index";
import { type AuditEventInput, auditInsert } from "./audit-event-write";
import type { Db } from "./client";
import {
  missingReferencedVariants,
  referencedVariantMustExist,
  targetingRuleWriteFailure,
} from "./flag-config-variant-refs";
import type { EnvScope } from "./scope";

export type ReplaceTargetingRulesResult =
  | { ok: true; config: typeof flagConfigs.$inferSelect }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "id_conflict" }
  | { ok: false; reason: "missing_variant"; missingVariantIds: string[] };

export type TargetingRuleWrite = Omit<
  typeof targetingRules.$inferInsert,
  "appId" | "environmentId" | "flagId"
>;
export type FlagConfigWritePatch = Partial<
  Pick<
    typeof flagConfigs.$inferInsert,
    "enabled" | "availableVariantNames" | "rollout" | "updatedAt" | "updatedBy" | "updatedVia"
  >
>;

export async function updateDirectFlagConfig(
  db: Db,
  scope: EnvScope,
  flagId: string,
  patch: FlagConfigWritePatch & { defaultVariantId?: string | null },
  audit?: AuditEventInput,
) {
  // Increment in SQL so concurrent writers cannot publish the same version.
  const mutation = db
    .update(flagConfigs)
    .set({ ...patch, version: sql`${flagConfigs.version} + 1` })
    .where(scopedFlagConfig(scope, flagId))
    .returning();
  const rows = audit
    ? (
        await db.batch([
          mutation,
          auditInsert(db, scope, audit, {
            targetVersion: configVersion(scope, flagId),
            resourceId: configId(scope, flagId),
          }),
        ])
      )[0]
    : await mutation;
  return rows[0] ?? null;
}

export async function replaceDirectTargetingRules(
  db: Db,
  scope: EnvScope,
  flagId: string,
  rows: TargetingRuleWrite[],
  configPatch: FlagConfigWritePatch,
  audit?: AuditEventInput,
): Promise<ReplaceTargetingRulesResult> {
  const batch = [
    ...referencedVariantMustExist(db, scope, flagId, rows),
    db.delete(targetingRules).where(scopedTargetingRule(scope, flagId)).returning(),
    ...rows.map((row) =>
      db
        .insert(targetingRules)
        .values({
          ...row,
          appId: scope.appId,
          environmentId: scope.environmentId,
          flagId,
        })
        .returning(),
    ),
    db
      .update(flagConfigs)
      .set({ ...configPatch, version: sql`${flagConfigs.version} + 1` })
      .where(scopedFlagConfig(scope, flagId))
      .returning(),
  ];
  try {
    const results = await db.batch([
      ...batch,
      ...(audit
        ? [
            auditInsert(db, scope, audit, {
              targetVersion: configVersion(scope, flagId),
              resourceId: configId(scope, flagId),
            }),
          ]
        : []),
    ] as unknown as Parameters<Db["batch"]>[0]);
    const updated = results[batch.length - 1] as (typeof flagConfigs.$inferSelect)[] | undefined;
    return updated?.[0] ? { ok: true, config: updated[0] } : { ok: false, reason: "not_found" };
  } catch (cause) {
    return targetingRuleWriteFailure(
      cause,
      await missingReferencedVariants(db, scope, flagId, rows),
    );
  }
}

export function scopedTargetingRule(scope: EnvScope, flagId: string) {
  return and(
    eq(targetingRules.appId, scope.appId),
    eq(targetingRules.environmentId, scope.environmentId),
    eq(targetingRules.flagId, flagId),
  );
}

function configVersion(scope: EnvScope, flagId: string) {
  return sql`(SELECT CAST(version AS TEXT) FROM flag_configs
    WHERE app_id = ${scope.appId} AND environment_id = ${scope.environmentId} AND flag_id = ${flagId})`;
}

function configId(scope: EnvScope, flagId: string) {
  return sql`(SELECT id FROM flag_configs
    WHERE app_id = ${scope.appId} AND environment_id = ${scope.environmentId} AND flag_id = ${flagId})`;
}

export function scopedFlagConfig(scope: EnvScope, flagId: string) {
  return and(
    eq(flagConfigs.appId, scope.appId),
    eq(flagConfigs.environmentId, scope.environmentId),
    eq(flagConfigs.flagId, flagId),
  );
}
