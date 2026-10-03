import { and, eq } from "drizzle-orm";
import { runSrmAlarms } from "../schema/index";
import type { Db } from "./client";
import { assertMintedScope, type EnvScope } from "./scope";

type RunSrmKind = "exposure" | "activated";

export interface RunSrmAlarmRow {
  readonly runId: string;
  readonly srmKind: RunSrmKind;
  readonly firstCrossedAt: string;
  readonly watermark: string;
  readonly pValue: number;
  readonly analysisVersion: string;
  readonly appId: string;
  readonly environmentId: string;
}

export interface PersistRunSrmAlarmInput {
  readonly runId: string;
  readonly srmKind: RunSrmKind;
  readonly firstCrossedAt: string;
  readonly watermark: string;
  readonly pValue: number;
  readonly analysisVersion: string;
}

/**
 * Durable analysis-v2 SRM alarms. INSERT OR IGNORE so the first crossing wins
 * and is never overwritten. Callers only touch this for analysis-v2 Runs.
 */
export function makeRunSrmAlarmRepo(db: Db, d1: D1Database) {
  return {
    async listForRun(scope: EnvScope, runId: string): Promise<readonly RunSrmAlarmRow[]> {
      assertMintedScope(scope);
      const rows = await db
        .select()
        .from(runSrmAlarms)
        .where(
          and(
            eq(runSrmAlarms.appId, scope.appId),
            eq(runSrmAlarms.environmentId, scope.environmentId),
            eq(runSrmAlarms.runId, runId),
          ),
        );
      return rows.map(toRow);
    },

    /**
     * Persist the first observed crossing. Ignores duplicates so a later read
     * with a different watermark or p-value cannot rewrite history.
     */
    async insertIgnore(scope: EnvScope, input: PersistRunSrmAlarmInput): Promise<void> {
      assertMintedScope(scope);
      await d1
        .prepare(
          `INSERT OR IGNORE INTO run_srm_alarms (
            run_id, srm_kind, first_crossed_at, watermark, p_value,
            analysis_version, app_id, environment_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.runId,
          input.srmKind,
          input.firstCrossedAt,
          input.watermark,
          input.pValue,
          input.analysisVersion,
          scope.appId,
          scope.environmentId,
        )
        .run();
    },

    async deleteForRun(scope: EnvScope, runId: string): Promise<void> {
      assertMintedScope(scope);
      await d1
        .prepare(
          `DELETE FROM run_srm_alarms
           WHERE app_id = ? AND environment_id = ? AND run_id = ?`,
        )
        .bind(scope.appId, scope.environmentId, runId)
        .run();
    },
  };
}

function toRow(row: typeof runSrmAlarms.$inferSelect): RunSrmAlarmRow {
  return {
    runId: row.runId,
    srmKind: row.srmKind,
    firstCrossedAt: row.firstCrossedAt,
    watermark: row.watermark,
    pValue: row.pValue,
    analysisVersion: row.analysisVersion,
    appId: row.appId,
    environmentId: row.environmentId,
  };
}
