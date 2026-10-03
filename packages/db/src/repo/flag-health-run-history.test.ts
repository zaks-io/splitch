import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appScope, createRepository } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedTwoTenants } from "./test-seed";

const NOW = "2026-06-28T00:00:00.000Z";

let local: LocalD1;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  seed = await seedTwoTenants(local.d1);
});

afterEach(async () => {
  await local.dispose();
});

describe("flagHealth.latestRunLifecycleAtByFlagEnv", () => {
  it("keeps End on Flag A after the Experiment is reassigned to Flag B", async () => {
    const endAt = "2026-07-01T12:00:00.000Z";
    const flagB = "flag_reassigned_b";
    await insertFlag({
      id: flagB,
      key: "reassigned-b",
      lifecycleClass: "release",
      createdAt: NOW,
    });

    await local.d1
      .prepare(
        `UPDATE runs
         SET status = 'ended', ended_at = ?, end_reason = 'reassign-test'
         WHERE id = ?`,
      )
      .bind(endAt, seed.a.runId)
      .run();
    await local.d1
      .prepare(
        `UPDATE flag_change_events
         SET changed_at = ?
         WHERE app_id = ? AND flag_id = ? AND target_type = 'run'
           AND json_extract(diff_json, '$.runId') = ?`,
      )
      .bind(endAt, seed.a.appId, seed.a.flagId, seed.a.runId)
      .run();

    await local.d1
      .prepare(`UPDATE experiments SET flag_id = ? WHERE id = ?`)
      .bind(flagB, seed.a.experimentId)
      .run();

    const repo = createRepository(local.d1);
    const lifecycle = await repo.flagHealth.latestRunLifecycleAtByFlagEnv(
      appScope(seed.a.appId),
      [seed.a.flagId, flagB],
      [seed.a.environmentId],
    );

    expect(lifecycle.get(`${seed.a.flagId}\0${seed.a.environmentId}`)).toBe(endAt);
    expect(lifecycle.has(`${flagB}\0${seed.a.environmentId}`)).toBe(false);
  });
});

describe("flagHealth.hasInWindowLegacyRuns", () => {
  it("detects an ended Run with no Start change-log row inside the window", async () => {
    const endedAt = "2026-06-20T00:00:00.000Z";
    await local.d1
      .prepare(
        `UPDATE runs
         SET status = 'ended', ended_at = ?, end_reason = 'legacy-test'
         WHERE id = ?`,
      )
      .bind(endedAt, seed.a.runId)
      .run();
    await local.d1
      .prepare(
        `DELETE FROM flag_change_events
         WHERE app_id = ? AND target_type = 'run'
           AND json_extract(diff_json, '$.runId') = ?`,
      )
      .bind(seed.a.appId, seed.a.runId)
      .run();

    const repo = createRepository(local.d1);
    await expect(
      repo.flagHealth.hasInWindowLegacyRuns(appScope(seed.a.appId), "2026-06-02T12:00:00.000Z"),
    ).resolves.toBe(true);
    await expect(
      repo.flagHealth.hasInWindowLegacyRuns(appScope(seed.a.appId), "2026-06-21T00:00:00.000Z"),
    ).resolves.toBe(false);
  });

  it("returns false when an ended in-window Run still has its Start change-log row", async () => {
    const endedAt = "2026-07-02T12:00:00.000Z";
    await local.d1
      .prepare(
        `UPDATE runs
         SET status = 'ended', ended_at = ?, end_reason = 'logged-end'
         WHERE id = ?`,
      )
      .bind(endedAt, seed.a.runId)
      .run();

    const repo = createRepository(local.d1);
    await expect(
      repo.flagHealth.hasInWindowLegacyRuns(appScope(seed.a.appId), "2026-06-02T12:00:00.000Z"),
    ).resolves.toBe(false);
  });
});

async function insertFlag(input: {
  id: string;
  key: string;
  lifecycleClass: string;
  createdAt: string;
}): Promise<void> {
  await local.d1
    .prepare(
      `INSERT INTO flags (
         id, app_id, key, name, lifecycle_class, created_at, updated_at, created_by, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'user_seed', 'user_seed')`,
    )
    .bind(
      input.id,
      seed.a.appId,
      input.key,
      input.key,
      input.lifecycleClass,
      input.createdAt,
      input.createdAt,
    )
    .run();
  await local.d1
    .prepare(
      `INSERT INTO variants (id, flag_id, name, value, created_at)
       VALUES (?, ?, 'control', '"control"', ?)`,
    )
    .bind(`var_${input.id}`, input.id, input.createdAt)
    .run();
}
