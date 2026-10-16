import { and, eq, isNull, sql } from "drizzle-orm";
import { apiKeys, clientKeys } from "../schema/index";
import { type AuditContext, auditInsert } from "./audit-event-write";
import type { Db } from "./client";
import type { EnvScope } from "./scope";

export function makeCredentialMintOps(db: Db) {
  return {
    async createApiKey(scope: EnvScope, values: typeof apiKeys.$inferInsert, audit: AuditContext) {
      const [rows] = await db.batch([
        db
          .insert(apiKeys)
          .values({ ...values, appId: scope.appId, environmentId: scope.environmentId })
          .returning(),
        auditInsert(db, scope, {
          ...audit,
          action: "api_keys_create",
          resourceType: "credential",
          resourceId: values.keyId,
          environmentId: scope.environmentId,
        }),
      ]);
      if (!rows[0]) throw new Error("createApiKey: committed credential was not returned");
      return rows[0];
    },

    async rotateClientKey(
      scope: EnvScope,
      currentKeyId: string,
      values: typeof clientKeys.$inferInsert,
      audit: AuditContext,
    ) {
      const [revoked, created] = await db.batch([
        db
          .update(clientKeys)
          .set({ revokedAt: audit.changedAt })
          .where(
            and(
              eq(clientKeys.appId, scope.appId),
              eq(clientKeys.environmentId, scope.environmentId),
              eq(clientKeys.keyId, currentKeyId),
              isNull(clientKeys.revokedAt),
            ),
          )
          .returning(),
        db
          .insert(clientKeys)
          .select(
            db
              .select({
                keyId: sql<string>`${values.keyId}`.as("key_id"),
                appId: clientKeys.appId,
                environmentId: clientKeys.environmentId,
                keyMaterial: sql<string>`${values.keyMaterial}`.as("key_material"),
                originAllowlist: sql<string | null>`${values.originAllowlist ?? null}`.as(
                  "origin_allowlist",
                ),
                rateLimitRps: sql<number | null>`${values.rateLimitRps ?? null}`.as(
                  "rate_limit_rps",
                ),
                revokedAt: sql<string | null>`NULL`.as("revoked_at"),
                createdAt: sql<string>`${values.createdAt ?? audit.changedAt}`.as("created_at"),
                createdBy: sql<string | null>`${values.createdBy ?? null}`.as("created_by"),
              })
              .from(clientKeys)
              .where(
                and(
                  eq(clientKeys.appId, scope.appId),
                  eq(clientKeys.environmentId, scope.environmentId),
                  eq(clientKeys.keyId, currentKeyId),
                  sql`changes() = 1`,
                ),
              ),
          )
          .returning(),
        auditInsert(db, scope, {
          ...audit,
          action: "client_key_rotate",
          resourceType: "credential",
          resourceId: values.keyId,
          environmentId: scope.environmentId,
          metadata: { revokedKeyId: currentKeyId },
        }),
      ]);
      return revoked[0] && created[0] ? { revoked: revoked[0], created: created[0] } : null;
    },
  };
}
