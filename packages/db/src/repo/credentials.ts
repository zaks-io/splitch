import { asc, eq, gt } from "drizzle-orm";
import { apiKeys, apps, clientKeys } from "../schema/index";
import type { Db } from "./client";
import type { EnvScope } from "./scope";
import { scopedTable } from "./scoped-table";

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

    listApiKeys(scope: EnvScope) {
      return apiKeysTable.findMany(scope);
    },

    /** Global D1 authority used only by the schema-v1 credential cache backfill. */
    listApiKeysForCacheBackfill(afterKeyId?: string, limit = 25) {
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
        .where(afterKeyId === undefined ? undefined : gt(apiKeys.keyId, afterKeyId))
        .orderBy(asc(apiKeys.keyId))
        .limit(limit);
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

    async revokeApiKey(scope: EnvScope, keyId: string, revokedAt: string) {
      const rows = await apiKeysTable.update(
        scope,
        { revokedAt, lastRotatedAt: revokedAt },
        eq(apiKeys.keyId, keyId),
      );
      return rows[0] ?? null;
    },

    removeApiKey(scope: EnvScope, keyId: string) {
      return apiKeysTable.remove(scope, eq(apiKeys.keyId, keyId));
    },

    listClientKeys(scope: EnvScope) {
      return clientKeysTable.findMany(scope);
    },

    /** Global D1 authority used only by the schema-v1 credential cache backfill. */
    listClientKeysForCacheBackfill(afterKeyId?: string, limit = 25) {
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
        .where(afterKeyId === undefined ? undefined : gt(clientKeys.keyId, afterKeyId))
        .orderBy(asc(clientKeys.keyId))
        .limit(limit);
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
    ) {
      const rows = await clientKeysTable.update(scope, values, eq(clientKeys.keyId, keyId));
      return rows[0] ?? null;
    },

    removeClientKey(scope: EnvScope, keyId: string) {
      return clientKeysTable.remove(scope, eq(clientKeys.keyId, keyId));
    },
  };
}
