import { and, eq, gte, inArray, isNotNull, max, or, sql, type SQL } from "drizzle-orm";
import { flagChangeEvents, runs } from "../schema/index";
import type { Db } from "./client";
import { twoAxisIdBatches } from "./id-batches";
import { assertMintedScope, type TenantScope, withTenantScope } from "./scope";

const CHANGE_SCOPE = {
  appId: flagChangeEvents.appId,
  appIdKey: "appId",
} as const;

const RUN_SCOPE = {
  appId: runs.appId,
  appIdKey: "appId",
} as const;

function requireSql(value: SQL | undefined, label: string): SQL {
  if (!value) throw new Error(`flag-health-run-history: ${label} produced no SQL`);
  return value;
}

/**
 * Latest Start/End instant per Flag × Environment for uniform-serving windows.
 *
 * Runs do not store `flag_id`; `experiments.flag_id` is mutable after End (PATCH
 * may reassign the Experiment). Attribution therefore uses `flag_change_events`
 * with `target_type = 'run'`, which stamp `flag_id` at Start/End from the
 * Experiment's Flag *at that instant*. Legacy Runs with no change-log row are
 * omitted (attribution unknown) — never rebound through the Experiment's
 * current `flagId`. Callers must probe `hasInWindowLegacyRuns` and fail loud
 * when any such Run still affects the uniform-serving window.
 */
export async function loadLatestRunLifecycleAtByFlagEnv(
  db: Db,
  scope: TenantScope,
  flagIds: readonly string[],
  environmentIds: readonly string[],
): Promise<Map<string, string>> {
  assertMintedScope(scope);
  if (flagIds.length === 0 || environmentIds.length === 0) return new Map();
  const out = new Map<string, string>();
  const pages = await Promise.all(
    twoAxisIdBatches(flagIds, environmentIds).map(({ first, second }) =>
      db
        .select({
          flagId: flagChangeEvents.flagId,
          environmentId: flagChangeEvents.environmentId,
          latestChangedAt: max(flagChangeEvents.changedAt),
        })
        .from(flagChangeEvents)
        .where(
          withTenantScope(
            CHANGE_SCOPE,
            scope,
            requireSql(
              and(
                eq(flagChangeEvents.targetType, "run"),
                inArray(flagChangeEvents.flagId, first),
                inArray(flagChangeEvents.environmentId, second),
              ),
              "run lifecycle predicate",
            ),
          ),
        )
        .groupBy(flagChangeEvents.flagId, flagChangeEvents.environmentId),
    ),
  );
  for (const row of pages.flat()) {
    if (row.environmentId === null) {
      throw new Error(
        `latestRunLifecycleAtByFlagEnv: Flag ${row.flagId} has a run change-log row with null environmentId`,
      );
    }
    if (row.latestChangedAt === null) {
      throw new Error(
        `latestRunLifecycleAtByFlagEnv: Flag ${row.flagId} env ${row.environmentId} has run change-log rows but no changedAt`,
      );
    }
    out.set(`${row.flagId}\0${row.environmentId}`, row.latestChangedAt);
  }
  return out;
}

/**
 * A legacy Run is one with no Start change-log row (`target_type=run` and
 * `diff_json.runNumber` present, as the INSERT trigger writes). The Run
 * snapshot does not freeze `flag_id`, and Experiment.flagId is mutable, so
 * there is no immutable Flag source to backfill from.
 *
 * Returns true when any such Run in the App is still running or ended at or
 * after `windowStartIso` (the uniform-serving history window floor).
 */
export async function loadHasInWindowLegacyRuns(
  db: Db,
  scope: TenantScope,
  windowStartIso: string,
): Promise<boolean> {
  assertMintedScope(scope);
  // Start (INSERT) rows carry runNumber; End (status UPDATE) rows do not.
  const hasStartLog = sql`exists (
    select 1 from ${flagChangeEvents} as start_log
    where start_log.app_id = ${runs.appId}
      and start_log.target_type = 'run'
      and json_extract(start_log.diff_json, '$.runId') = ${runs.id}
      and json_extract(start_log.diff_json, '$.runNumber') is not null
  )`;
  const inWindow = requireSql(
    or(eq(runs.status, "running"), and(isNotNull(runs.endedAt), gte(runs.endedAt, windowStartIso))),
    "legacy run window predicate",
  );
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      withTenantScope(
        RUN_SCOPE,
        scope,
        requireSql(and(inWindow, sql`not ${hasStartLog}`), "legacy run predicate"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
