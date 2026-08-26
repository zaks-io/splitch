import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { flagConfigs, targetingRules } from "../schema/index";
import {
  appliedRequestUpdate,
  appliedReviewInsert,
  appliedReviewQueries,
  approvalPendingCondition,
  approvalReviewLanded,
  reviewRecorded,
} from "./approval-atomic";
import type { ApprovalCommit } from "./approval-types";
import type { Db } from "./client";
import { idBatches } from "./id-batches";
import type { EnvScope } from "./scope";
import { assertMintedScope } from "./scope";
import type { ScopedTable } from "./scoped-table";
import { hasUniqueViolationMessage, uniqueViolationMessage } from "./unique-violation";

export type ReplaceTargetingRulesResult =
  | { ok: true; config: typeof flagConfigs.$inferSelect }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "id_conflict" };

/**
 * SQLite reports a composite unique-index violation by COLUMN LIST, not by
 * index name. Matching the whole constraint string keeps this from swallowing
 * a different fault on the same columns.
 */
const TARGETING_RULE_ID_UNIQUE_VIOLATION =
  "UNIQUE constraint failed: targeting_rules.app_id, targeting_rules.environment_id, targeting_rules.flag_id, targeting_rules.id";
const TARGETING_RULE_ID_UNIQUE_MESSAGE = uniqueViolationMessage(TARGETING_RULE_ID_UNIQUE_VIOLATION);

/**
 * Per-Environment Flag CONFIGURATION reads and writes (ADR-0027), split out of
 * `makeFlagRepo` so the flag repo stays readable as the config surface grows.
 * Every operation takes an `EnvScope`, so the tenant boundary is the same one
 * `scopedTable` enforces for the rest of the domain.
 */
export function makeFlagConfigOps(
  db: Db,
  flagConfigsTable: ScopedTable<typeof flagConfigs>,
  targetingRulesTable: ScopedTable<typeof targetingRules>,
) {
  return {
    getFlagConfig(scope: EnvScope, flagId: string) {
      return flagConfigsTable.findOne(scope, eq(flagConfigs.flagId, flagId));
    },

    getFlagConfigById(scope: EnvScope, configId: string) {
      return flagConfigsTable.findOne(scope, eq(flagConfigs.id, configId));
    },

    /**
     * One Environment's Flag Configurations for an already-bounded Flag page.
     * The EnvScope supplies both app_id and environment_id at the repository
     * boundary; batching only works around D1's bound-parameter ceiling.
     */
    async listFlagConfigsByFlagIds(scope: EnvScope, flagIds: readonly string[]) {
      if (flagIds.length === 0) return [] as (typeof flagConfigs.$inferSelect)[];
      const pages = await Promise.all(
        idBatches(flagIds).map((batch) =>
          flagConfigsTable.findMany(scope, inArray(flagConfigs.flagId, [...batch])),
        ),
      );
      return pages.flat();
    },

    /**
     * Flag Configurations in this Environment changed at or after `since`, most
     * recently changed first, bounded to `limit` rows.
     *
     * Exists so a "what changed lately" surface costs what it renders instead of
     * what the Environment holds: the unbounded read this replaces made every
     * page load scale with the App's Flag count.
     *
     * `updated_at` is fixed-width ISO-8601 TEXT, so the lexicographic comparison
     * SQLite applies IS the chronological one — no conversion, and the `>=` bound
     * and the DESC order agree with how a caller reads the column in JS.
     *
     * Ordered by `(updated_at DESC, id DESC)`. `id` is the table's PRIMARY KEY, so
     * the pair is a TOTAL order. Timestamps collide (a batch write stamps one
     * `updated_at` across rows), and without the tiebreaker which of the tied rows
     * a `LIMIT` dropped would vary between two otherwise identical reads.
     *
     * Ask for one row more than you intend to keep and you learn whether you
     * truncated, rather than inferring it from a full page.
     */
    listRecentFlagConfigs(scope: EnvScope, since: string, limit: number) {
      return flagConfigsTable.findMany(scope, gte(flagConfigs.updatedAt, since), {
        limit,
        orderBy: [desc(flagConfigs.updatedAt), desc(flagConfigs.id)],
      });
    },

    /**
     * Insert the initial disabled Flag Configuration when absent. Retries against
     * the `(flag_id, environment_id)` unique index return the existing row.
     */
    async ensureInitialFlagConfig(
      scope: EnvScope,
      values: Omit<typeof flagConfigs.$inferInsert, "appId" | "environmentId"> & {
        flagId: string;
      },
    ): Promise<typeof flagConfigs.$inferSelect> {
      const existing = await flagConfigsTable.findOne(scope, eq(flagConfigs.flagId, values.flagId));
      if (existing) return existing;

      try {
        return await flagConfigsTable.insert(scope, {
          ...values,
          appId: scope.appId,
          environmentId: scope.environmentId,
        });
      } catch (cause) {
        const winner = await flagConfigsTable.findOne(scope, eq(flagConfigs.flagId, values.flagId));
        if (winner) return winner;
        throw cause;
      }
    },

    removeFlagConfig(scope: EnvScope, flagId: string): Promise<number> {
      return flagConfigsTable.remove(scope, eq(flagConfigs.flagId, flagId));
    },

    removeTargetingRules(scope: EnvScope, flagId: string): Promise<number> {
      return targetingRulesTable.remove(scope, eq(targetingRules.flagId, flagId));
    },

    async updateFlagConfig(
      scope: EnvScope,
      flagId: string,
      patch: Partial<
        Pick<
          typeof flagConfigs.$inferInsert,
          | "enabled"
          | "availableVariantNames"
          | "defaultVariantId"
          | "rollout"
          | "updatedAt"
          | "updatedBy"
          | "updatedVia"
        >
      >,
      approval?: ApprovalCommit,
    ): Promise<typeof flagConfigs.$inferSelect | null> {
      assertMintedScope(scope);
      const current = await flagConfigsTable.findOne(scope, eq(flagConfigs.flagId, flagId));
      if (!current) return null;
      if (approval) {
        const mutation = db
          .update(flagConfigs)
          .set({ ...patch, version: current.version + 1 })
          .where(
            and(
              scopedFlagConfig(scope, flagId),
              eq(flagConfigs.version, current.version),
              approvalPendingCondition(db, scope, approval),
            ),
          )
          .returning({ id: flagConfigs.id });
        // `changes() = 1` binds the Review to this exact mutation statement.
        await db.batch([
          mutation,
          ...appliedReviewQueries(db, scope, approval),
        ] as unknown as Parameters<Db["batch"]>[0]);
        // The guard can lose (request resolved, reviewer role revoked, Policy
        // level changed, version CAS lost) and leave every statement a no-op.
        // Returning the re-read row would report that as an applied change.
        if (!(await approvalReviewLanded(db, scope, approval))) return null;
        return flagConfigsTable.findOne(scope, eq(flagConfigs.flagId, flagId));
      }
      // The version bumps in SQL: `current.version + 1` is a stale read-modify-
      // write, and two concurrent writers would both land on the same version.
      // Raw update because the scoped facade only accepts plain column values.
      const rows = await db
        .update(flagConfigs)
        .set({ ...patch, version: sql`${flagConfigs.version} + 1` })
        .where(scopedFlagConfig(scope, flagId))
        .returning();
      return rows[0] ?? null;
    },

    listTargetingRules(scope: EnvScope, flagId: string) {
      return targetingRulesTable.findMany(scope, eq(targetingRules.flagId, flagId));
    },

    async listTargetingRulesByFlagIds(scope: EnvScope, flagIds: readonly string[]) {
      if (flagIds.length === 0) return [] as (typeof targetingRules.$inferSelect)[];
      const pages = await Promise.all(
        idBatches(flagIds).map((batch) =>
          targetingRulesTable.findMany(scope, inArray(targetingRules.flagId, [...batch])),
        ),
      );
      return pages.flat();
    },

    async replaceTargetingRules(
      scope: EnvScope,
      flagId: string,
      rows: TargetingRuleWrite[],
      configPatch: FlagConfigWritePatch,
      approval?: ApprovalCommit,
    ): Promise<ReplaceTargetingRulesResult> {
      assertMintedScope(scope);
      const current = await flagConfigsTable.findOne(scope, eq(flagConfigs.flagId, flagId));
      if (!current) return { ok: false, reason: "not_found" };
      return approval
        ? replaceApprovedTargetingRules(
            db,
            flagConfigsTable,
            scope,
            flagId,
            current.version,
            rows,
            configPatch,
            approval,
          )
        : replaceDirectTargetingRules(db, scope, flagId, rows, configPatch);
    },
  };
}

type TargetingRuleWrite = Omit<
  typeof targetingRules.$inferInsert,
  "appId" | "environmentId" | "flagId"
>;
type FlagConfigWritePatch = Partial<
  Pick<
    typeof flagConfigs.$inferInsert,
    "enabled" | "availableVariantNames" | "rollout" | "updatedAt" | "updatedBy" | "updatedVia"
  >
>;

async function replaceApprovedTargetingRules(
  db: Db,
  flagConfigsTable: ScopedTable<typeof flagConfigs>,
  scope: EnvScope,
  flagId: string,
  currentVersion: number,
  rows: TargetingRuleWrite[],
  configPatch: FlagConfigWritePatch,
  approval: ApprovalCommit,
): Promise<ReplaceTargetingRulesResult> {
  // The Review row is this attempt's unique evidence: the rule writes ride
  // along with it, and it is itself bound to the config bump by changes().
  const evidence = reviewRecorded(db, scope, approval);
  const guardedDelete = db
    .delete(targetingRules)
    .where(and(scopedTargetingRule(scope, flagId), evidence))
    .returning();
  const guardedInserts = rows.map((row) =>
    db.insert(targetingRules).select(
      db
        .select({
          id: sql<string>`${row.id}`.as("id"),
          appId: sql<string>`${scope.appId}`.as("app_id"),
          environmentId: sql<string>`${scope.environmentId}`.as("environment_id"),
          flagId: sql<string>`${flagId}`.as("flag_id"),
          priority: sql<number>`${row.priority}`.as("priority"),
          conditions: sql<string>`${row.conditions}`.as("conditions"),
          segmentId: sql<string | null>`${row.segmentId ?? null}`.as("segment_id"),
          variantId: sql<string | null>`${row.variantId ?? null}`.as("variant_id"),
          percentageRollout: sql<string | null>`${row.percentageRollout ?? null}`.as(
            "percentage_rollout",
          ),
          createdAt: sql<string>`${row.createdAt}`.as("created_at"),
          updatedAt: sql<string>`${row.updatedAt}`.as("updated_at"),
        })
        .from(flagConfigs)
        .where(and(scopedFlagConfig(scope, flagId), evidence))
        .limit(1),
    ),
  );
  const guardedUpdate = db
    .update(flagConfigs)
    .set({ ...configPatch, version: currentVersion + 1 })
    .where(
      and(
        scopedFlagConfig(scope, flagId),
        eq(flagConfigs.version, currentVersion),
        approvalPendingCondition(db, scope, approval),
      ),
    )
    .returning();
  try {
    await db.batch([
      guardedUpdate,
      appliedReviewInsert(db, scope, approval),
      guardedDelete,
      ...guardedInserts,
      appliedRequestUpdate(db, scope, approval),
    ] as unknown as Parameters<Db["batch"]>[0]);
  } catch (cause) {
    return targetingRuleWriteFailure(cause);
  }
  if (!(await approvalReviewLanded(db, scope, approval))) {
    return { ok: false, reason: "not_found" };
  }
  const approved = await flagConfigsTable.findOne(scope, eq(flagConfigs.flagId, flagId));
  return approved ? { ok: true, config: approved } : { ok: false, reason: "not_found" };
}

async function replaceDirectTargetingRules(
  db: Db,
  scope: EnvScope,
  flagId: string,
  rows: TargetingRuleWrite[],
  configPatch: FlagConfigWritePatch,
): Promise<ReplaceTargetingRulesResult> {
  const batch = [
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
    const results = await db.batch(batch as unknown as Parameters<Db["batch"]>[0]);
    const updated = results.at(-1) as (typeof flagConfigs.$inferSelect)[] | undefined;
    return updated?.[0] ? { ok: true, config: updated[0] } : { ok: false, reason: "not_found" };
  } catch (cause) {
    return targetingRuleWriteFailure(cause);
  }
}

function targetingRuleWriteFailure(cause: unknown): ReplaceTargetingRulesResult {
  if (hasUniqueViolationMessage(cause, TARGETING_RULE_ID_UNIQUE_MESSAGE)) {
    return { ok: false, reason: "id_conflict" };
  }
  throw cause;
}

export function scopedTargetingRule(scope: EnvScope, flagId: string) {
  return and(
    eq(targetingRules.appId, scope.appId),
    eq(targetingRules.environmentId, scope.environmentId),
    eq(targetingRules.flagId, flagId),
  );
}

export function scopedFlagConfig(scope: EnvScope, flagId: string) {
  return and(
    eq(flagConfigs.appId, scope.appId),
    eq(flagConfigs.environmentId, scope.environmentId),
    eq(flagConfigs.flagId, flagId),
  );
}
