import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { STATE_SCHEMA } from "./state-schema";
import { StateStorage } from "./state-storage";
import { baseSnapshot } from "./worker-test-fixtures";

describe("SplitchState storage migrations", () => {
  it("upgrades an existing v1 integration without losing its applied snapshot", async () => {
    const state = env.SPLITCH_STATE.getByName("v1-storage-migration");
    const snapshot = { ...baseSnapshot, environmentVersion: 17 };
    const migrated = await runInDurableObject(state, async (_instance, durableState) => {
      const sql = durableState.storage.sql;
      sql.exec("DROP TABLE integration; DELETE FROM _sql_schema_migrations");
      sql.exec(`CREATE TABLE integration (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        installation_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        snapshot_version INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      )`);
      sql.exec(
        `INSERT INTO integration (
          singleton, installation_id, app_id, environment_id, identity_key,
          snapshot_version, applied_at
        ) VALUES (1, ?, ?, ?, 'identity-key', ?, '2026-08-25T00:00:00.000Z')`,
        env.SPLITCH_INSTALLATION_ID,
        snapshot.appId,
        snapshot.environmentId,
        snapshot.environmentVersion,
      );
      sql.exec("INSERT INTO snapshot (singleton, payload) VALUES (1, ?)", JSON.stringify(snapshot));
      sql.exec("INSERT INTO _sql_schema_migrations (id) VALUES (1)");

      new StateStorage(durableState.storage).initialize(STATE_SCHEMA);
      return {
        integration: new StateStorage(durableState.storage).integration(),
        migrations: sql
          .exec<{ id: number }>("SELECT id FROM _sql_schema_migrations ORDER BY id")
          .toArray()
          .map(({ id }) => id),
      };
    });

    expect(migrated).toMatchObject({
      integration: {
        installationId: env.SPLITCH_INSTALLATION_ID,
        appId: "app_1",
        environmentId: "env_1",
        identityKey: "identity-key",
        snapshotVersion: 17,
        announcedVersion: 17,
      },
      migrations: [1, 2],
    });
    await expect(
      state.evaluateDetails("checkout", {
        targetingKey: "person_1",
        idempotencyKey: "evaluation-after-v1-migration",
      }),
    ).resolves.toMatchObject({ value: false, variantName: "control" });
  });
});
