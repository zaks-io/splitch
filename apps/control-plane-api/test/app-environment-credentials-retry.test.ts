import { createRepository, envScope } from "@splitch/db";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { revokeEnvironmentCredentialsForAppDelete } from "../src/app-environment-credentials";
import type { LocalBindings } from "../src/test-fixtures";
import { seedOrgApp, seedOrgMember } from "../src/test-seeds";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

/**
 * SPL-298: a D1 revoke that lands before a KV tombstone failure must still
 * re-tombstone on the next App-delete attempt — with a revoked payload.
 * A live key must quiesce in one put when liveness is recomputed after revoke.
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

function countingWriter(opts?: { failOnPut?: number }) {
  const putValues: string[] = [];
  const putCredentials: Array<{ kind: string; keyId: string }> = [];
  let putCount = 0;
  return {
    putValues,
    putCredentials,
    get putCount() {
      return putCount;
    },
    writer: {
      writerFor() {
        return {
          async put(write: {
            value: string;
            credential: { kind: "api_key" | "client_key"; keyId: string };
          }) {
            putCount += 1;
            putValues.push(write.value);
            putCredentials.push(write.credential);
            if (opts?.failOnPut !== undefined && putCount === opts.failOnPut) {
              throw new Error("simulated tombstone fault");
            }
          },
        };
      },
    },
  };
}

function expectRevokedTombstones(
  putValues: readonly string[],
  putCredentials: ReadonlyArray<{ kind: string; keyId: string }>,
  keyId: string,
): void {
  expect(putCredentials.every((c) => c.kind === "client_key" && c.keyId === keyId)).toBe(true);
  for (const raw of putValues) {
    const envelope = JSON.parse(raw) as {
      data: { revoked: boolean; kind: string; appId: string; environmentId: string };
    };
    expect(envelope.data).toMatchObject({
      revoked: true,
      kind: "client_key",
      appId: ORG.appId,
      environmentId: ENV_ID,
    });
  }
}

describe("revokeEnvironmentCredentialsForAppDelete retry (SPL-298)", () => {
  let bindings: LocalBindings;

  // Workers pool isolates storage per FILE, not per test — seed fixed IDs once.
  beforeAll(async () => {
    const seed = await makeLocalBindings();
    await seedOrgApp(seed.d1, ORG);
    await seedOrgMember(seed.d1, { orgId: ORG.orgId, userId: OWNER, role: "owner" });
    await seed.d1
      .prepare(
        `INSERT INTO environments (id, app_id, key, name, policy, created_at, updated_at)
         VALUES (?, ?, 'dev', 'Dev', '{}', ?, ?)`,
      )
      .bind(ENV_ID, ORG.appId, NOW, NOW)
      .run();
    await seed.d1
      .prepare(
        `INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`,
      )
      .bind(ORG.appId, OWNER, NOW)
      .run();
  });

  beforeEach(async () => {
    bindings = await makeLocalBindings();
    // Per-file D1: clear credentials so each case starts from an empty Env.
    await bindings.d1
      .prepare(`DELETE FROM client_keys WHERE app_id = ? AND environment_id = ?`)
      .bind(ORG.appId, ENV_ID)
      .run();
    await bindings.d1
      .prepare(`DELETE FROM api_keys WHERE app_id = ? AND environment_id = ?`)
      .bind(ORG.appId, ENV_ID)
      .run();
  });

  afterEach(async () => bindings.dispose());

  it("re-tombstones an already-revoked Client Key with a revoked payload", async () => {
    const keyId = "ck_retry_already_revoked";
    await bindings.d1
      .prepare(
        `INSERT INTO client_keys (key_id, app_id, environment_id, key_material, created_at, revoked_at)
         VALUES (?, ?, ?, 'material_retry', ?, ?)`,
      )
      .bind(keyId, ORG.appId, ENV_ID, NOW, NOW)
      .run();

    const repo = createRepository(bindings.d1);
    const fake = countingWriter({ failOnPut: 1 });

    await expect(
      revokeEnvironmentCredentialsForAppDelete(
        {
          repo,
          credentialCacheWriter: fake.writer,
          nowIso: () => NOW,
        },
        ORG.appId,
        ENV_ID,
      ),
    ).rejects.toThrow(/simulated tombstone fault/);

    await revokeEnvironmentCredentialsForAppDelete(
      {
        repo,
        credentialCacheWriter: fake.writer,
        nowIso: () => NOW,
      },
      ORG.appId,
      ENV_ID,
    );

    // Already-revoked retry path: fail once, then succeed — two puts total.
    // This does not distinguish post-revoke vs pre-revoke liveness (both see
    // zero live rows); see the live-key test below for that pin.
    expect(fake.putCount).toBe(2);
    expectRevokedTombstones(fake.putValues, fake.putCredentials, keyId);

    const keys = await repo.credentials.listClientKeys(envScope(ORG.appId, ENV_ID));
    expect(keys).toHaveLength(1);
    expect(keys[0]?.keyId).toBe(keyId);
    expect(keys[0]?.revokedAt).toBe(NOW);
  });

  it("quiesces a live Client Key in one tombstone put", async () => {
    const keyId = "ck_retry_live";
    await bindings.d1
      .prepare(
        `INSERT INTO client_keys (key_id, app_id, environment_id, key_material, created_at, revoked_at)
         VALUES (?, ?, ?, 'material_live', ?, NULL)`,
      )
      .bind(keyId, ORG.appId, ENV_ID, NOW)
      .run();

    const repo = createRepository(bindings.d1);
    const fake = countingWriter();

    await revokeEnvironmentCredentialsForAppDelete(
      {
        repo,
        credentialCacheWriter: fake.writer,
        nowIso: () => NOW,
      },
      ORG.appId,
      ENV_ID,
    );

    // Post-revoke liveness recompute: 1 put. Filtering the pre-revoke snapshot
    // would still see the key as live and force a redundant second pass (2 puts).
    expect(fake.putCount).toBe(1);
    expectRevokedTombstones(fake.putValues, fake.putCredentials, keyId);

    const keys = await repo.credentials.listClientKeys(envScope(ORG.appId, ENV_ID));
    expect(keys).toHaveLength(1);
    expect(keys[0]?.keyId).toBe(keyId);
    expect(keys[0]?.revokedAt).toBe(NOW);
  });
});
