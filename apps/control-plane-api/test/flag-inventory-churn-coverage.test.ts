import { createRepository } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLAG_CHANGE_LOG_RETENTION_MS } from "../src/flag-change-log-retention";
import {
  allowAllPolicies,
  appToken,
  baseFlag,
  createDefaultApp,
  createFlag,
  type FlagDefinitionHarness,
  makeFlagDefinitionHarness,
  NOW_ISO,
  request,
} from "../src/flag-definition-test-harness";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness(makeLocalBindings);
});

afterEach(async () => h.bindings.dispose());

/**
 * Create + delete inside one month, then prune past the create (same retention
 * floor as the cron). Surviving totals remain, but the month is partial.
 */
describe("flag_inventory_health_get churn coverage after prune", () => {
  it("labels a pruned month partial while keeping surviving counts", async () => {
    const created = await createDefaultApp(h);
    const appId = created.app.id;
    const jwt = await appToken(h, appId);
    await allowAllPolicies(h, appId);

    const doomed = await createFlag(h, appId, jwt, {
      ...baseFlag(appId),
      key: "july-churn",
      name: "july-churn",
      lifecycleClass: "permission",
    });
    const del = await request(
      h,
      "DELETE",
      `/apps/${appId}/flags/${doomed.id}`,
      jwt,
      undefined,
      `idem-delete-july-churn-${crypto.randomUUID()}`,
    );
    expect(del.status).toBe(200);

    // July 1 create ages past the 90-day floor; July 20 delete still survives.
    await h.bindings.d1
      .prepare(
        `UPDATE flag_change_events
         SET changed_at = ?
         WHERE app_id = ? AND flag_id = ? AND action = 'created' AND target_type = 'flag'`,
      )
      .bind("2026-01-01T00:00:00.000Z", appId, doomed.id)
      .run();
    await h.bindings.d1
      .prepare(
        `UPDATE flag_change_events
         SET changed_at = ?
         WHERE app_id = ? AND flag_id = ? AND action = 'deleted' AND target_type = 'flag'`,
      )
      .bind("2026-07-20T00:00:00.000Z", appId, doomed.id)
      .run();

    const retentionBoundary = new Date(
      Date.parse(NOW_ISO) - FLAG_CHANGE_LOG_RETENTION_MS,
    ).toISOString();
    const pruned = await createRepository(h.bindings.d1).flagChangeEvents.pruneBefore({
      changedBefore: retentionBoundary,
      minUndeliveredSeq: Number.MAX_SAFE_INTEGER,
      limit: 1_000,
    });
    expect(pruned).toBeGreaterThanOrEqual(1);

    const res = await request(h, "GET", `/apps/${appId}/flag-inventory-health`, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      monthlyChurn: {
        months: Array<{
          month: string;
          added: number;
          removed: number;
          coverage: "complete" | "partial";
        }>;
        historyCoverageStartsAt: string | null;
      };
    };

    expect(body.monthlyChurn.months.find((row) => row.month === "2026-07")).toMatchObject({
      month: "2026-07",
      added: 0,
      removed: 1,
      coverage: "partial",
    });
  });
});
