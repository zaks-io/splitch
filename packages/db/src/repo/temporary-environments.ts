import { and, asc, eq, gt, isNull, lte } from "drizzle-orm";
import { environments } from "../schema/index";
import type { Db } from "./client";
import { assertMintedScope, type TenantScope } from "./scope";
import { type ReadOptions, scopedTable } from "./scoped-table";

export function makeTemporaryEnvironmentRepo(db: Db, d1: D1Database) {
  const table = scopedTable(db, environments);
  return {
    listPermanentEnvironments(scope: TenantScope, options?: ReadOptions) {
      return table.findMany(scope, isNull(environments.expiresAt), {
        ...options,
        orderBy: options?.orderBy ?? [asc(environments.createdAt), asc(environments.key)],
      });
    },

    countPermanentEnvironments(scope: TenantScope) {
      return table.countRows(scope, isNull(environments.expiresAt));
    },

    async liveTemporaryEnvironmentSummary(scope: TenantScope, now: string) {
      const live = await table.findMany(scope, gt(environments.expiresAt, now), {
        orderBy: [asc(environments.expiresAt), asc(environments.id)],
        limit: 50,
      });
      return { active: live.length, nextExpiresAt: live[0]?.expiresAt ?? null };
    },

    async fenceTemporaryEnvironment(scope: TenantScope, environmentId: string, now: string) {
      assertMintedScope(scope);
      await d1
        .prepare(
          `UPDATE environments SET expires_at = CASE WHEN expires_at > ? THEN ? ELSE expires_at END,
          updated_at = ? WHERE app_id = ? AND id = ? AND expires_at IS NOT NULL`,
        )
        .bind(now, now, now, scope.appId, environmentId)
        .run();
      return table.findOne(scope, eq(environments.id, environmentId));
    },

    async updateTemporaryEnvironmentSync(
      scope: TenantScope,
      environmentId: string,
      fromEnvironmentId: string,
      now: string,
    ) {
      const rows = await table.update(
        scope,
        {
          syncedFromEnvironmentId: fromEnvironmentId,
          syncedAt: now,
          updatedAt: now,
        },
        and(eq(environments.id, environmentId), gt(environments.expiresAt, now)),
      );
      return rows[0] ?? null;
    },

    async deleteTemporaryEnvironmentData(scope: TenantScope, environmentId: string) {
      assertMintedScope(scope);
      const environment = await table.findOne(scope, eq(environments.id, environmentId));
      if (!environment) return;
      if (environment.expiresAt === null)
        throw new Error("Temporary Environment teardown requires a temporary Environment");
      // The batch preserves the manifest if any dependent or final FK check fails.
      await d1.batch([
        d1
          .prepare("DELETE FROM targeting_rules WHERE app_id = ? AND environment_id = ?")
          .bind(scope.appId, environmentId),
        d1
          .prepare("DELETE FROM flag_configs WHERE app_id = ? AND environment_id = ?")
          .bind(scope.appId, environmentId),
        d1
          .prepare(
            "DELETE FROM environments WHERE app_id = ? AND id = ? AND expires_at IS NOT NULL",
          )
          .bind(scope.appId, environmentId),
      ]);
    },

    async createTemporaryEnvironment(
      scope: TenantScope,
      input: {
        id: string;
        key: string;
        name: string;
        policy: string;
        expiresAt: string;
        syncedFromEnvironmentId: string;
        syncedAt: string;
        createdBy: string;
      },
      now: string,
      limit: number,
    ) {
      assertMintedScope(scope);
      const result = await d1
        .prepare(
          `INSERT INTO environments
          (id, app_id, key, name, policy, expires_at, synced_from_environment_id,
           synced_at, created_at, updated_at, created_by)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM environments WHERE app_id = ? AND expires_at > ?) < ?`,
        )
        .bind(
          input.id,
          scope.appId,
          input.key,
          input.name,
          input.policy,
          input.expiresAt,
          input.syncedFromEnvironmentId,
          input.syncedAt,
          now,
          now,
          input.createdBy,
          scope.appId,
          now,
          limit,
        )
        .run();
      return result.meta.changes === 1 ? table.findOne(scope, eq(environments.id, input.id)) : null;
    },

    /** System cron scan, bounded before materialization and ordered across Apps. */
    async listExpiredTemporaryEnvironments(now: string, limit: number) {
      const rows = await db
        .select()
        .from(environments)
        .where(buildExpiredTemporaryEnvironmentsPredicate(now))
        .orderBy(asc(environments.expiresAt), asc(environments.id))
        .limit(limit);
      return rows;
    },
  };
}

export function buildExpiredTemporaryEnvironmentsPredicate(now: string) {
  return lte(environments.expiresAt, now);
}
