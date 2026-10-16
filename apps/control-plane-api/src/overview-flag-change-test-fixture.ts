import type { FlagChangeLogRow } from "@splitch/db";
import { beforeEach } from "vitest";
import { setupAttentionRollupFixture } from "./attention-rollup-fixture";
import { ids, NOW } from "./config-store-fixture-data";
import { makePoolBindings } from "./test-bindings-pool";

/** Pin event time independently of the trigger's wall clock and live Configuration timestamps. */
export function setupOverviewFixture(): void {
  setupAttentionRollupFixture();
  beforeEach(async () => {
    const { d1 } = await makePoolBindings();
    await d1.prepare("DELETE FROM flag_change_events").run();
    await seedOverviewEvent();
  });
}

export async function seedOverviewEvent(overrides: Partial<FlagChangeLogRow> = {}) {
  const row = {
    appId: ids.appId,
    environmentId: ids.environmentId,
    flagId: ids.flagId,
    flagKey: ids.flagKey,
    action: "updated",
    targetType: "flag_config",
    actorRef: null,
    actorVia: null,
    changedAt: NOW,
    diffJson: null,
    ...overrides,
  };
  const { d1 } = await makePoolBindings();
  await d1
    .prepare(
      `INSERT INTO flag_change_events
        (app_id, environment_id, flag_id, flag_key, action, target_type,
         actor_ref, actor_via, changed_at, diff_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.appId,
      row.environmentId,
      row.flagId,
      row.flagKey,
      row.action,
      row.targetType,
      row.actorRef,
      row.actorVia,
      row.changedAt,
      row.diffJson,
    )
    .run();
}
