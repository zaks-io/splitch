import { and, desc, eq, isNull } from "drizzle-orm";
import { apiKeys, apps, clientKeys } from "../schema/index";
import { type AuditContext, auditInsert } from "./audit-event-write";
import type { Db } from "./client";
import { makeCredentialMintOps } from "./credential-mint";
import { type EnvScope, withScope } from "./scope";
import { type ReadOptions, scopedTable } from "./scoped-table";

/**
 * Credential-domain repository. Both tables are per-Environment (ADR-0027): an
 * API Key or Client Key belongs to exactly one (app, environment) pair, so every
 * method requires an EnvScope. A credential lookup can therefore never return a
 * key minted for another App or Environment.
 *
 * Note: per-call HOT validation of a key is served from KV, not here (ADR-0018);
 * this repo is the relational system of record for the key records themselves
 * (provision, list, revoke).
 */
export function makeCredentialRepo(db: Db) {
  const apiKeysTable = scopedTable(db, apiKeys);
  const clientKeysTable = scopedTable(db, clientKeys);

  return {
    apiKeys: apiKeysTable,
    clientKeys: clientKeysTable,

    ...makeCredentialMintOps(db),

    listApiKeys(scope: EnvScope, options?: ReadOptions) {
      return apiKeysTable.findMany(scope, undefined, {
        ...options,
        orderBy: options?.orderBy ?? [desc(apiKeys.createdAt), desc(apiKeys.keyId)],
      });
    },

    /** Authoritative row check for a serialized credential-cache write. */
    getApiKeyForCacheBackfill(keyId: string) {
      return db
        .select({
          keyId: apiKeys.keyId,
          appId: apiKeys.appId,
          environmentId: apiKeys.environmentId,
          keyHash: apiKeys.keyHash,
          scopes: apiKeys.scopes,
          revokedAt: apiKeys.revokedAt,
          organizationId: apps.organizationId,
        })
        .from(apiKeys)
        .innerJoin(apps, eq(apps.id, apiKeys.appId))
        .where(eq(apiKeys.keyId, keyId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },

    getApiKey(scope: EnvScope, keyId: string) {
      return apiKeysTable.findOne(scope, eq(apiKeys.keyId, keyId));
    },

    async revokeApiKey(scope: EnvScope, keyId: string, revokedAt: string, audit?: AuditContext) {
      const query = db
        .update(apiKeys)
        .set({ revokedAt, lastRotatedAt: revokedAt })
        .where(
          withScope(
            { appId: apiKeys.appId, appIdKey: "appId", environmentId: apiKeys.environmentId },
            scope,
            and(eq(apiKeys.keyId, keyId), isNull(apiKeys.revokedAt)),
          ),
        )
        .returning();
      const rows = audit
        ? (
            await db.batch([
              query,
              auditInsert(db, scope, {
                ...audit,
                action: "api_keys_revoke",
                resourceType: "credential",
                resourceId: keyId,
                environmentId: scope.environmentId,
              }),
            ])
          )[0]
        : await query;
      return rows[0] ?? null;
    },

    removeApiKey(scope: EnvScope, keyId: string) {
      return apiKeysTable.remove(scope, eq(apiKeys.keyId, keyId));
    },

    listClientKeys(scope: EnvScope) {
      return clientKeysTable.findMany(scope);
    },

    /** Authoritative row check for a serialized credential-cache write. */
    getClientKeyForCacheBackfill(keyId: string) {
      return db
        .select({
          keyId: clientKeys.keyId,
          appId: clientKeys.appId,
          environmentId: clientKeys.environmentId,
          keyMaterial: clientKeys.keyMaterial,
          originAllowlist: clientKeys.originAllowlist,
          rateLimitRps: clientKeys.rateLimitRps,
          revokedAt: clientKeys.revokedAt,
          organizationId: apps.organizationId,
        })
        .from(clientKeys)
        .innerJoin(apps, eq(apps.id, clientKeys.appId))
        .where(eq(clientKeys.keyId, keyId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },

    getClientKey(scope: EnvScope, keyId: string) {
      return clientKeysTable.findOne(scope, eq(clientKeys.keyId, keyId));
    },

    async updateClientKey(
      scope: EnvScope,
      keyId: string,
      values: Partial<typeof clientKeys.$inferInsert>,
      audit?: AuditContext,
    ) {
      if (!audit)
        return (
          (await clientKeysTable.update(scope, values, eq(clientKeys.keyId, keyId)))[0] ?? null
        );
      if ("appId" in values || "environmentId" in values)
        throw new Error("updateClientKey: cannot set scope columns");
      const query = db
        .update(clientKeys)
        .set(values)
        .where(
          withScope(
            { appId: clientKeys.appId, appIdKey: "appId", environmentId: clientKeys.environmentId },
            scope,
            eq(clientKeys.keyId, keyId),
          ),
        )
        .returning();
      const [rows] = await db.batch([
        query,
        auditInsert(db, scope, {
          ...audit,
          action: "client_key_update",
          resourceType: "credential",
          resourceId: keyId,
          environmentId: scope.environmentId,
          metadata: {
            changedFields: Object.keys(values).filter(
              (field) => field === "originAllowlist" || field === "rateLimitRps",
            ),
          },
        }),
      ]);
      return rows[0] ?? null;
    },

    removeClientKey(scope: EnvScope, keyId: string) {
      return clientKeysTable.remove(scope, eq(clientKeys.keyId, keyId));
    },
  };
}
