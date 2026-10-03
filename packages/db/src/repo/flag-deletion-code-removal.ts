import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { apps, flagChangeEvents, flags } from "../schema/index";
import { reviewRecorded } from "./approval-atomic";
import type { ApprovalCommit } from "./approval-types";
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
 * Both audit writes are gated on evidence THIS attempt deleted the Flag:
 * Approval application uses `reviewRecorded` (durable after the Review insert);
 * direct deletion uses `changes() = 1` from the Flag DELETE on the INSERT that
 * must run immediately after that DELETE. A losing attempt must not patch a
 * legacy NULL `diff_json` row or insert a new claim.
 *
 * Production D1 has an AFTER DELETE trigger that inserts a NULL `diff_json`
 * row. Approval application patches that row in place (UPDATE) then INSERTs
 * only when no claimed row exists. Direct deletion INSERTs the claim while
 * `changes()` still refers to the Flag DELETE, then removes the trigger's NULL
 * placeholder once a claimed row exists — same batch, same guard. The claim
 * must land either way: the trigger cannot see the request body.
 *
 * Must run in the same `db.batch` as the Flag DELETE (after Approval commit
 * statements, which need `changes()` from that DELETE).
 */
export function codeRemovalClaimBatchStatements(
  db: Db,
  scope: TenantScope,
  flag: { id: string; key: string; updatedBy: string | null },
  codeRemoval: FlagDeletionCodeRemovalRecord,
  options?: { approval?: ApprovalCommit },
) {
  assertMintedScope(scope);
  const flagId = flag.id;
  const diffJson = JSON.stringify({ codeRemoval });
  const approval = options?.approval;
  // Approval: Review row is durable evidence bound to the Flag DELETE via
  // changes()=1 on the Review insert. Direct: changes() from the Flag DELETE —
  // only the first claim statement below may consume it.
  const deletedThisAttempt = approval ? reviewRecorded(db, scope, approval) : sql`changes() = 1`;
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
  // Nested subquery: SQLite forbids selecting the UPDATE target in a plain
  // FROM subquery of the same statement.
  const claimUpdate = db
    .update(flagChangeEvents)
    .set({ diffJson })
    .where(
      and(
        deletedThisAttempt,
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
    );
  // Triggerless D1 (or a wiped audit table): INSERT the claimed deletion row
  // when THIS attempt deleted the Flag and no claimed row exists yet. Column
  // list must match the table definition order (drizzle insert().select
  // requirement).
  const claimInsert = db.insert(flagChangeEvents).select(
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
          deletedThisAttempt,
          sql`NOT EXISTS (
            SELECT 1 FROM ${flags}
            WHERE ${and(eq(flags.appId, scope.appId), eq(flags.id, flagId))}
          )`,
          sql`NOT ${claimedDeletionExists}`,
        ),
      ),
  );
  // Direct path cannot UPDATE-then-INSERT: both need changes()=1 from the Flag
  // DELETE, and only the first statement sees it. INSERT the claim first, then
  // drop the trigger's NULL placeholder once a claimed row exists. Approval
  // keeps UPDATE-then-INSERT so the trigger row is patched in place.
  // Gated on deletedThisAttempt so a loser cannot remove the winner's NULL
  // placeholder when a claimed row already exists from another attempt. After a
  // successful direct INSERT, changes() still equals 1 from that INSERT.
  const dropNullPlaceholder = db
    .delete(flagChangeEvents)
    .where(
      and(
        deletedThisAttempt,
        eq(flagChangeEvents.appId, scope.appId),
        eq(flagChangeEvents.flagId, flagId),
        eq(flagChangeEvents.action, "deleted"),
        eq(flagChangeEvents.targetType, "flag"),
        isNull(flagChangeEvents.environmentId),
        isNull(flagChangeEvents.diffJson),
        sql`${claimedDeletionExists}`,
      ),
    );
  const auditWrites = approval ? [claimUpdate, claimInsert] : [claimInsert, dropNullPlaceholder];
  return [
    ...auditWrites,
    // FROM apps (not flag_change_events): a `.from(flag_change_events).limit(1)`
    // guard returns zero rows when retention emptied the table and the deletion
    // trigger is missing, so ELSE json('') never runs and the Flag DELETE would
    // commit without a claim. The App row always exists for an in-scope delete,
    // so the CASE always evaluates. Prefer existence over changes(): Approval
    // commit statements also modify rows before this guard, and changes() would
    // be ambiguous after those writes. json('') is only evaluated on the failing
    // branch, which aborts the batch.
    //
    // A losing attempt (Flag already gone, this attempt did not delete) must
    // not abort: NOT deletedThisAttempt allows the batch to complete without
    // attaching a claim to the winner's audit row.
    db
      .select({
        ok: sql<number>`CASE
          WHEN EXISTS (
            SELECT 1 FROM ${flags}
            WHERE ${and(eq(flags.appId, scope.appId), eq(flags.id, flagId))}
          ) THEN 1
          WHEN NOT (${deletedThisAttempt}) THEN 1
          WHEN ${claimedDeletionExists} THEN 1
          ELSE json('')
        END`.as("ok"),
      })
      .from(apps)
      .where(eq(apps.id, scope.appId))
      .limit(1),
  ] as const;
}
