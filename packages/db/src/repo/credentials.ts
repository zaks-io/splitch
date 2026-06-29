import { eq } from "drizzle-orm";
import { apiKeys, clientKeys } from "../schema/index.js";
import type { Db } from "./client.js";
import type { EnvScope } from "./scope.js";
import { scopedTable } from "./scoped-table.js";

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

    getApiKey(scope: EnvScope, keyId: string) {
      return apiKeysTable.findOne(scope, eq(apiKeys.keyId, keyId));
    },

    listClientKeys(scope: EnvScope) {
      return clientKeysTable.findMany(scope);
    },

    getClientKey(scope: EnvScope, keyId: string) {
      return clientKeysTable.findOne(scope, eq(clientKeys.keyId, keyId));
    },
  };
}
