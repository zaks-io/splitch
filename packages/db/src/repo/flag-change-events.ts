/**
 * Reads over the append-only flag-change log.
 *
 * WRITES live in D1 triggers (0026_flag_change_log.sql), never here. That is
 * what makes the log un-bypassable, so this module deliberately exposes no
 * insert.
 *
 * Both methods are SYSTEM reads driven by the cron, not tenant reads: they run
 * with no caller and no scope, exactly like `convex.claimDueDeliveries`. Every
 * row they return is bounded by the `org_id` the caller already holds from a
 * claimed installation row, so no scope is fabricated. When the read surface for
 * humans lands, it goes through the scoped seam instead.
 */

export interface FlagChangeEventRow {
  seq: number;
  appId: string;
  environmentId: string | null;
  flagKey: string;
  action: "created" | "updated" | "deleted";
  targetType: string;
  actorRef: string | null;
  actorVia: string | null;
  changedAt: string;
}

export function makeFlagChangeEventRepo(d1: D1Database) {
  return {
    /**
     * The next batch of changes an Organization-bound integration has not seen:
     * every App under the Organization, every Environment, in `seq` order.
     *
     * Both axes are deliberate. Sentry's flag log has no project or environment
     * field, so there is nothing narrower to publish to, and an Environment
     * filter here would hide real production changes the moment an operator
     * picked the wrong Environment.
     *
     * Apps are resolved through a subquery rather than a join so the cursor scan
     * stays on `flag_change_events`. An App's log rows are deleted with the App
     * (`app-delete-cascade`), so no row this misses could still be deliverable.
     */
    async pendingForOrg(
      orgId: string,
      afterSeq: number,
      limit: number,
    ): Promise<FlagChangeEventRow[]> {
      const rows = await d1
        .prepare(
          `SELECT seq, app_id AS appId, environment_id AS environmentId, flag_key AS flagKey,
            action, target_type AS targetType, actor_ref AS actorRef, actor_via AS actorVia,
            changed_at AS changedAt
          FROM flag_change_events
          WHERE app_id IN (SELECT id FROM apps WHERE organization_id = ?) AND seq > ?
          ORDER BY seq ASC LIMIT ?`,
        )
        .bind(orgId, afterSeq, limit)
        .all<FlagChangeEventRow>();
      return rows.results;
    },

    /**
     * Retention. Only prunes history every active integration has already
     * consumed: `minUndeliveredSeq` is the lowest cursor across active
     * installations, so a lagging or backed-off integration can never have its
     * backlog deleted out from under it. With no active installation the caller
     * passes `Number.MAX_SAFE_INTEGER` and age alone governs.
     */
    async pruneBefore(input: {
      changedBefore: string;
      minUndeliveredSeq: number;
      limit: number;
    }): Promise<number> {
      const result = await d1
        .prepare(
          `DELETE FROM flag_change_events WHERE seq IN (
            SELECT seq FROM flag_change_events
            WHERE changed_at < ? AND seq < ? ORDER BY seq ASC LIMIT ?
          )`,
        )
        .bind(input.changedBefore, input.minUndeliveredSeq, input.limit)
        .run();
      return result.meta.changes ?? 0;
    },
  };
}
