import { createRepository, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { revokeEnvironmentCredentialsForAppDelete } from "../src/app-environment-credentials";
import type { LocalBindings } from "../src/test-fixtures";
import { seedOrgApp, seedOrgMember } from "../src/test-seeds";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

/**
 * SPL-298: a D1 revoke that lands before a KV tombstone failure must still
 * re-tombstone on the next App-delete attempt.
 */

const NOW = "2026-08-04T12:00:00.000Z";
const ORG = {
  orgId: "org_cred_retry_tombstone",
  orgName: "Cred Retry Co",
  appId: "app_cred_retry_tombstone",
  appName: "Cred Retry App",
  appKey: "cred-retry-app",
};
const OWNER = "user_cred_retry_tombstone";
const ENV_ID = "env_cred_retry_tombstone";

describe("revokeEnvironmentCredentialsForAppDelete retry (SPL-298)", () => {
  let bindings: LocalBindings;

  beforeEach(async () => {
    bindings = await makeLocalBindings();
    await seedOrgApp(bindings.d1, ORG);
    await seedOrgMember(bindings.d1, { orgId: ORG.orgId, userId: OWNER, role: "owner" });
    await bindings.d1
      .prepare(
        `INSERT INTO environments (id, app_id, key, name, policy, created_at, updated_at)
         VALUES (?, ?, 'dev', 'Dev', '{}', ?, ?)`,
      )
      .bind(ENV_ID, ORG.appId, NOW, NOW)
      .run();
    await bindings.d1
      .prepare(
        `INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`,
      )
      .bind(ORG.appId, OWNER, NOW)
      .run();
    await bindings.d1
      .prepare(
        `INSERT INTO client_keys (key_id, app_id, environment_id, key_material, created_at, revoked_at)
         VALUES ('ck_retry', ?, ?, 'material_retry', ?, ?)`,
      )
      .bind(ORG.appId, ENV_ID, NOW, NOW)
      .run();
  });

  afterEach(async () => bindings.dispose());

  it("re-tombstones an already-revoked Client Key on a later pass", async () => {
    const repo = createRepository(bindings.d1);
    let puts = 0;
    const failingOnceStore = {
      async get() {
        return null;
      },
      async put() {
        puts += 1;
        if (puts === 1) throw new Error("simulated tombstone fault");
      },
      async delete() {},
      async list() {
        return { keys: [], list_complete: true, cacheStatus: null };
      },
      async getWithMetadata() {
        return { value: null, metadata: null, cacheStatus: null };
      },
    } as unknown as KVNamespace;

    await expect(
      revokeEnvironmentCredentialsForAppDelete(
        { repo, credentialStore: failingOnceStore, nowIso: () => NOW },
        ORG.appId,
        ENV_ID,
      ),
    ).rejects.toThrow(/simulated tombstone fault/);

    await revokeEnvironmentCredentialsForAppDelete(
      { repo, credentialStore: failingOnceStore, nowIso: () => NOW },
      ORG.appId,
      ENV_ID,
    );

    expect(puts).toBeGreaterThanOrEqual(2);
    const keys = await repo.credentials.listClientKeys(envScope(ORG.appId, ENV_ID));
    expect(keys).toHaveLength(1);
    expect(keys[0]?.revokedAt).toBe(NOW);
  });
});
