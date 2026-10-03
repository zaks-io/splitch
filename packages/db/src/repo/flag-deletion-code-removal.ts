import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { apps, flagChangeEvents, flags } from "../schema/index";
import type { Db } from "./client";
import { assertMintedScope, type TenantScope } from "./scope";

/**
 * Auditable code-removal claim stored on the Flag deletion audit row.
 * Shape matches contracts `FlagCodeRemovalRecord`; kept local so @splitch/db
 * does not take a contracts dependency.
 */
export type FlagDeletionCodeRemovalRecord =
  | { state: "unknown" }
  | { state: "claimed"; reference: string };

/**
 * Statements that patch the AFTER DELETE audit row's NULL `diff_json` with the
 * code-removal claim, then abort the batch if the Flag was deleted but the
 * claim write missed. When the Flag still exists (Approval no-op), the guard
 * allows the batch to complete so the caller can return not-applied.
 *
 * Must run in the same `db.batch` as the Flag DELETE (after Approval commit
 * statements, which need `changes()` from that DELETE).
 */
export function codeRemovalClaimBatchStatements(
  db: Db,
  scope: TenantScope,
  flagId: string,
  codeRemoval: FlagDeletionCodeRemovalRecord,
) {
  assertMintedScope(scope);
  const diffJson = JSON.stringify({ codeRemoval });
  return [
    // Nested subquery: SQLite forbids selecting the UPDATE target in a plain
    // FROM subquery of the same statement.
    db
      .update(flagChangeEvents)
      .set({ diffJson })
      .where(
        eq(
          flagChangeEvents.seq,
          sql`(
            SELECT seq FROM (
              SELECT seq FROM flag_change_events
              WHERE app_id = ${scope.appId}
                AND flag_id = ${flagId}
                AND action = 'deleted'
                AND target_type = 'flag'
                AND environment_id IS NULL
                AND diff_json IS NULL
              ORDER BY seq DESC
              LIMIT 1
            )
          )`,
        ),
      ),
    // FROM apps (not flag_change_events): a `.from(flag_change_events).limit(1)`
    // guard returns zero rows when retention emptied the table and the deletion
    // trigger is missing, so ELSE json('') never runs and the Flag DELETE would
    // commit. The App row always exists for an in-scope delete, so the CASE always
    // evaluates. Prefer existence over changes(): Approval commit statements also
    // modify rows before this guard, and changes() would be ambiguous after those
    // writes. json('') is only evaluated on the failing branch, which aborts the batch.
    db
      .select({
        ok: sql<number>`CASE
          WHEN EXISTS (
            SELECT 1 FROM ${flags}
            WHERE ${and(eq(flags.appId, scope.appId), eq(flags.id, flagId))}
          ) THEN 1
          WHEN EXISTS (
            SELECT 1 FROM ${flagChangeEvents}
            WHERE ${and(
              eq(flagChangeEvents.appId, scope.appId),
              eq(flagChangeEvents.flagId, flagId),
              eq(flagChangeEvents.action, "deleted"),
              eq(flagChangeEvents.targetType, "flag"),
              isNull(flagChangeEvents.environmentId),
              isNotNull(flagChangeEvents.diffJson),
            )}
          ) THEN 1
          ELSE json('')
        END`.as("ok"),
      })
      .from(apps)
      .where(eq(apps.id, scope.appId))
      .limit(1),
  ] as const;
}
