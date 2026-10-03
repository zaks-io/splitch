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
 * Statements that record the code-removal claim on the Flag deletion audit row,
 * then abort the batch if the Flag was deleted but the claim write missed.
 * When the Flag still exists (Approval no-op), the guard allows the batch to
 * complete so the caller can return not-applied.
 *
 * Production D1 has an AFTER DELETE trigger that inserts a NULL `diff_json`
 * row; the UPDATE patches that row. Fixture D1s (and a missing trigger) get an
 * INSERT of the claimed row instead — same batch, same guard. The claim must
 * land either way: the trigger cannot see the request body.
 *
 * Must run in the same `db.batch` as the Flag DELETE (after Approval commit
 * statements, which need `changes()` from that DELETE).
 */
export function codeRemovalClaimBatchStatements(
  db: Db,
  scope: TenantScope,
  flag: { id: string; key: string; updatedBy: string | null },
  codeRemoval: FlagDeletionCodeRemovalRecord,
) {
  assertMintedScope(scope);
  const flagId = flag.id;
  const diffJson = JSON.stringify({ codeRemoval });
  const claimedDeletionExists = sql`EXISTS (
    SELECT 1 FROM ${flagChangeEvents}
    WHERE ${and(
      eq(flagChangeEvents.appId, scope.appId),
      eq(flagChangeEvents.flagId, flagId),
      eq(flagChangeEvents.action, "deleted"),
      eq(flagChangeEvents.targetType, "flag"),
      isNull(flagChangeEvents.environmentId),
      isNotNull(flagChangeEvents.diffJson),
    )}
  )`;
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
    // Triggerless D1 (or a wiped audit table): INSERT the claimed deletion row
    // when the Flag is gone and no claimed row exists yet. No-ops when the
    // UPDATE above already patched the trigger row. Column list must match the
    // table definition order (drizzle insert().select requirement).
    db.insert(flagChangeEvents).select(
      db
        .select({
          seq: sql<number | null>`NULL`.as("seq"),
          appId: sql<string>`${scope.appId}`.as("app_id"),
          environmentId: sql<string | null>`NULL`.as("environment_id"),
          flagId: sql<string>`${flagId}`.as("flag_id"),
          flagKey: sql<string>`${flag.key}`.as("flag_key"),
          action: sql<string>`'deleted'`.as("action"),
          targetType: sql<string>`'flag'`.as("target_type"),
          actorRef: sql<string | null>`${flag.updatedBy}`.as("actor_ref"),
          actorVia: sql<string | null>`NULL`.as("actor_via"),
          changedAt: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`.as("changed_at"),
          diffJson: sql<string>`${diffJson}`.as("diff_json"),
        })
        .from(apps)
        .where(
          and(
            eq(apps.id, scope.appId),
            sql`NOT EXISTS (
              SELECT 1 FROM ${flags}
              WHERE ${and(eq(flags.appId, scope.appId), eq(flags.id, flagId))}
            )`,
            sql`NOT ${claimedDeletionExists}`,
          ),
        ),
    ),
    // FROM apps (not flag_change_events): a `.from(flag_change_events).limit(1)`
    // guard returns zero rows when retention emptied the table and the deletion
    // trigger is missing, so ELSE json('') never runs and the Flag DELETE would
    // commit without a claim. The App row always exists for an in-scope delete,
    // so the CASE always evaluates. Prefer existence over changes(): Approval
    // commit statements also modify rows before this guard, and changes() would
    // be ambiguous after those writes. json('') is only evaluated on the failing
    // branch, which aborts the batch.
    db
      .select({
        ok: sql<number>`CASE
          WHEN EXISTS (
            SELECT 1 FROM ${flags}
            WHERE ${and(eq(flags.appId, scope.appId), eq(flags.id, flagId))}
          ) THEN 1
          WHEN ${claimedDeletionExists} THEN 1
          ELSE json('')
        END`.as("ok"),
      })
      .from(apps)
      .where(eq(apps.id, scope.appId))
      .limit(1),
  ] as const;
}
