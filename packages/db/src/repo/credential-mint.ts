import { apiKeys } from "../schema/index";
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
  };
}
