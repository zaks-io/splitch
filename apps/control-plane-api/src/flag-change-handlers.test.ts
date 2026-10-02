import { createRepository, envScope } from "@splitch/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALPHA,
  args,
  errorCode,
  seedFlag,
  seedTwoTenants,
  USER_MEMBER,
  USER_OUTSIDER,
} from "./app-settings-fixture";
import { makeFlagChangeHandlers } from "./flag-change-handlers";
import { seedEnvironment } from "./test-seeds";

const ENV_ID = "env_alpha_changes";
const ENV_TWO = "env_alpha_staging";
const FLAG_ID = "flag_alpha_changes";
const VARIANT_ID = "var_alpha_control";
const NOW = "2026-08-25T00:00:00.000Z";
const FROM = "2020-01-01T00:00:00.000Z";
const TO = "2099-01-01T00:00:00.000Z";

let dispose: () => Promise<void>;
let handlers: ReturnType<typeof makeFlagChangeHandlers>;
let d1: D1Database;

beforeAll(async () => {
  const local = await seedTwoTenants();
  dispose = local.dispose;
  d1 = local.d1;
  const repo = createRepository(d1);
  await seedEnvironment(d1, { appId: ALPHA.appId, environmentId: ENV_ID, key: "prod" });
  await seedEnvironment(d1, { appId: ALPHA.appId, environmentId: ENV_TWO, key: "staging" });
  await seedFlag(d1, {
    appId: ALPHA.appId,
    flagId: FLAG_ID,
    key: "checkout",
    name: "Checkout",
    variants: [{ id: VARIANT_ID, name: "control", value: '"control"' }],
  });
  const scope = envScope(ALPHA.appId, ENV_ID);
  await repo.flags.ensureInitialFlagConfig(scope, {
    id: "cfg_alpha_changes",
    flagId: FLAG_ID,
    enabled: false,
    availableVariantNames: "[]",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.flags.ensureInitialFlagConfig(envScope(ALPHA.appId, ENV_TWO), {
    id: "cfg_alpha_staging",
    flagId: FLAG_ID,
    enabled: false,
    availableVariantNames: "[]",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repo.flags.updateFlagConfig(scope, FLAG_ID, {
    enabled: true,
    updatedAt: NOW,
    updatedBy: USER_MEMBER,
    updatedVia: "api-key",
  });
  await d1
    .prepare("UPDATE variants SET value = ? WHERE id = ?")
    .bind('"changed"', VARIANT_ID)
    .run();
  await d1
    .prepare(
      `INSERT INTO targeting_rules (id, app_id, environment_id, flag_id, priority, conditions,
        created_at, updated_at)
       VALUES ('rule_alpha', ?, ?, ?, 1, '[]', ?, ?)`,
    )
    .bind(ALPHA.appId, ENV_ID, FLAG_ID, NOW, NOW)
    .run();
  await d1
    .prepare("UPDATE targeting_rules SET priority = 2, updated_at = ? WHERE id = 'rule_alpha'")
    .bind(NOW)
    .run();
  handlers = makeFlagChangeHandlers({ repo });
});

afterAll(async () => {
  await dispose();
});

function listArgs(query: Record<string, unknown>, userId = USER_MEMBER) {
  return {
    ...args(userId, ALPHA.appId, {}),
    input: { params: { appId: ALPHA.appId }, query },
  };
}

describe("flag change-log handlers", () => {
  it("diffs a targeting rule change, a variant change, and a kill switch toggle", async () => {
    const response = await handlers.list(listArgs({ limit: 50 }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{
        targetType: string;
        action: string;
        diff: { before: object | null; after: object | null };
      }>;
    };

    const killSwitch = body.items.find(
      (item) => item.targetType === "flag_config" && item.action === "updated",
    );
    expect(killSwitch?.diff.before).toMatchObject({ enabled: 0 });
    expect(killSwitch?.diff.after).toMatchObject({ enabled: 1 });

    const variant = body.items.find((item) => item.targetType === "variant");
    expect(variant?.diff.before).toMatchObject({ value: '"control"' });
    expect(variant?.diff.after).toMatchObject({ value: '"changed"' });

    const rule = body.items.find(
      (item) =>
        item.targetType === "targeting_rule" &&
        item.diff.before !== null &&
        "priority" in (item.diff.before ?? {}),
    );
    expect(rule?.diff.before).toMatchObject({ priority: 1 });
    expect(rule?.diff.after).toMatchObject({ priority: 2 });
  });

  it("exports a time range as JSON plus a unified text diff", async () => {
    const listed = await handlers.list(listArgs({ limit: 50 }));
    const listedBody = (await listed.json()) as { items: Array<{ changedAt: string }> };
    expect(listedBody.items.length).toBeGreaterThan(0);
    const response = await handlers.export(
      listArgs({
        from: FROM,
        to: TO,
        fromEnvironmentId: ENV_ID,
        toEnvironmentId: ENV_TWO,
        format: "unified",
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: unknown[];
      unifiedDiff: string;
      format: string;
      readTruncated: boolean;
    };
    expect(body.format).toBe("unified");
    expect(body.readTruncated).toBe(false);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.unifiedDiff).toContain("diff --git a/flag-changes/");
    expect(body.unifiedDiff).toContain("-enabled: 0");
    expect(body.unifiedDiff).toContain("+enabled: 1");
  });

  it("refuses an outsider and an inverted window", async () => {
    expect(await errorCode(await handlers.list(listArgs({}, USER_OUTSIDER)))).toBe("FORBIDDEN");
    expect(await errorCode(await handlers.export(listArgs({ from: TO, to: FROM })))).toBe(
      "VALIDATION_ERROR",
    );
  });
});
