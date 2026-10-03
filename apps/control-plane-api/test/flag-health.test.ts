import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

async function ownerSession() {
  const created = await createDefaultApp(h);
  return {
    appId: created.app.id,
    envIds: created.environments.map((environment) => environment.id),
    jwt: await appToken(h, created.app.id),
  };
}

function releaseBody(appId: string, key: string, expiresAt: string) {
  const { lifecycleClass: _, ...rest } = baseFlag(appId);
  return {
    ...rest,
    key,
    name: key,
    lifecycleClass: "release" as const,
    owner: "checkout-team",
    expiresAt,
  };
}

/** Set every Environment's config to a static uniform (or split) rollout and age it. */
async function setRolloutEverywhere(
  appId: string,
  flagId: string,
  percentage: number,
  updatedAt: string,
) {
  await h.bindings.d1
    .prepare(
      `UPDATE flag_configs
       SET enabled = 1,
           available_variant_names = ?,
           rollout = ?,
           updated_at = ?
       WHERE app_id = ? AND flag_id = ?`,
    )
    .bind(
      JSON.stringify(["control", "treatment"]),
      JSON.stringify({ percentage, salt: "stale-test-salt" }),
      updatedAt,
      appId,
      flagId,
    )
    .run();
}

describe("stale_flags_list", () => {
  it("returns a seeded 100%-for-30-days Flag and not a seeded 50/50 Flag", async () => {
    const { appId, jwt } = await ownerSession();
    expect(NOW_ISO).toBe("2026-07-02T12:00:00.000Z");
    const uniform = await createFlag(
      h,
      appId,
      jwt,
      releaseBody(appId, "full-rollout", "2026-12-01T00:00:00Z"),
    );
    const split = await createFlag(
      h,
      appId,
      jwt,
      releaseBody(appId, "fifty-fifty", "2026-12-01T00:00:00Z"),
    );
    await setRolloutEverywhere(appId, uniform.id, 100, "2026-05-01T00:00:00.000Z");
    await setRolloutEverywhere(appId, split.id, 50, "2026-05-01T00:00:00.000Z");

    const res = await request(h, "GET", `/apps/${appId}/stale-flags`, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        flag: { key: string };
        reasons: Array<{ kind: string }>;
        servingEvidence: string;
      }>;
    };
    expect(body.items.map((item) => item.flag.key)).toEqual(["full-rollout"]);
    expect(body.items[0]?.servingEvidence).toBe("unverified");
    expect(body.items[0]?.reasons.map((reason) => reason.kind)).toContain("uniform_serving");
  });

  it("includes past_expiry and never claims unused", async () => {
    const { appId, jwt } = await ownerSession();
    await createFlag(h, appId, jwt, releaseBody(appId, "expired-live", "2026-06-01T00:00:00Z"));
    const res = await request(h, "GET", `/apps/${appId}/stale-flags`, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ reasons: Array<{ kind: string }>; servingEvidence: string }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.servingEvidence).toBe("unverified");
    expect(body.items[0]?.reasons.map((reason) => reason.kind)).toContain("past_expiry");
  });
});

describe("flag_inventory_health_get", () => {
  it("counts by class, ages, monthly additions, and expired-but-live", async () => {
    const { appId, jwt } = await ownerSession();
    await allowAllPolicies(h, appId);
    await createFlag(h, appId, jwt, releaseBody(appId, "release-a", "2026-06-01T00:00:00Z"));
    await createFlag(h, appId, jwt, {
      ...baseFlag(appId),
      key: "ops-a",
      name: "ops-a",
      lifecycleClass: "ops",
    });

    // Age one Flag into the 30_90d bucket via created_at.
    await h.bindings.d1
      .prepare(`UPDATE flags SET created_at = ? WHERE app_id = ? AND key = ?`)
      .bind("2026-05-01T00:00:00.000Z", appId, "ops-a")
      .run();

    const doomed = await createFlag(h, appId, jwt, {
      ...baseFlag(appId),
      key: "to-delete",
      name: "to-delete",
      lifecycleClass: "permission",
    });
    const del = await request(
      h,
      "DELETE",
      `/apps/${appId}/flags/${doomed.id}`,
      jwt,
      undefined,
      `idem-delete-flag-${crypto.randomUUID()}`,
    );
    expect(del.status).toBe(200);

    const res = await request(h, "GET", `/apps/${appId}/flag-inventory-health`, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      appId: string;
      countsByLifecycleClass: Record<string, number>;
      ageDistribution: Array<{ bucket: string; count: number }>;
      monthlyChurn: {
        months: Array<{ month: string; added: number; removed: number }>;
        additionsSource: string;
        removalsSource: string;
      };
      expiredButLiveCount: number;
    };
    expect(body.appId).toBe(appId);
    expect(body.countsByLifecycleClass).toMatchObject({
      release: 1,
      ops: 1,
      permission: 0,
    });
    expect(body.expiredButLiveCount).toBe(1);
    expect(body.ageDistribution.find((row) => row.bucket === "0_30d")?.count).toBe(1);
    expect(body.ageDistribution.find((row) => row.bucket === "30_90d")?.count).toBe(1);
    expect(body.monthlyChurn.additionsSource).toBe("flag_created_at");
    expect(body.monthlyChurn.removalsSource).toBe("flag_change_log");
    // Change-log triggers stamp changed_at with SQLite utcnow, not the Worker clock.
    expect(body.monthlyChurn.months.some((row) => row.removed >= 1)).toBe(true);
    expect(body.monthlyChurn.months.some((row) => row.added >= 1)).toBe(true);
  });
});
