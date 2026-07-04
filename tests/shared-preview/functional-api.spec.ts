import { expect, test } from "./fixtures";

interface App {
  readonly id: string;
  readonly key: string;
  readonly organizationId: string;
}

interface Environment {
  readonly id: string;
  readonly key: string;
}

interface Flag {
  readonly id: string;
  readonly key: string;
  readonly variants: readonly { id: string; name: string; value: unknown }[];
}

test.describe("shared-preview functional API workflow", () => {
  test("creates an App and provisions Environments plus Client Keys", async ({
    accessToken,
    smoke,
  }) => {
    const key = smoke.uniqueKey("playwright-smoke-app");
    let createdApp: App | undefined;

    try {
      const created = await smoke.callTool<{
        app: App;
        environments: Environment[];
        clientKeys: { environmentId: string; isOriginOpen: boolean }[];
      }>(accessToken, "apps_create", {
        orgId: smoke.config.smokeOrgId,
        organizationId: smoke.config.smokeOrgId,
        name: `Playwright Smoke ${key}`,
        key,
        description: "Created by shared-preview Playwright smoke.",
        idempotency_key: key,
      });
      createdApp = created.app;

      expect(created.app).toMatchObject({ key, organizationId: smoke.config.smokeOrgId });
      expect(created.environments.map((environment) => environment.key)).toEqual(["dev", "prod"]);
      expect(created.clientKeys).toHaveLength(2);
      expect(created.clientKeys.every((clientKey) => clientKey.isOriginOpen)).toBe(true);
    } finally {
      if (createdApp) {
        await smoke.callTool(accessToken, "apps_delete", { appId: createdApp.id });
      }
    }
  });

  test("round-trips Flag definition CRUD on the seeded smoke App", async ({
    accessToken,
    smoke,
  }) => {
    let createdFlag: Flag | undefined;

    try {
      const key = smoke.uniqueKey("playwright-smoke-flag");
      createdFlag = await smoke.callTool<Flag>(accessToken, "flags_create", {
        appId: smoke.config.smokeAppId,
        name: "Playwright smoke flag",
        key,
        schema: { type: "boolean" },
        variants: [
          { name: "control", value: false, isDefault: true },
          { name: "treatment", value: true, isDefault: false },
        ],
        description: "Created by shared-preview Playwright smoke.",
      });

      expect(createdFlag).toMatchObject({ appId: smoke.config.smokeAppId, key });

      const fetched = await smoke.callTool<Flag>(accessToken, "flags_get", {
        appId: smoke.config.smokeAppId,
        flagId: createdFlag.id,
      });
      expect(fetched.variants.map((variant) => variant.name)).toEqual(["control", "treatment"]);

      const updated = await smoke.callTool<Flag>(accessToken, "flags_update", {
        appId: smoke.config.smokeAppId,
        flagId: createdFlag.id,
        name: "Playwright smoke flag updated",
        schema: { type: "boolean" },
        description: "Updated by shared-preview Playwright smoke.",
      });
      expect(updated).toMatchObject({ id: createdFlag.id, key });
    } finally {
      if (createdFlag) {
        await smoke.callTool(accessToken, "flags_delete", {
          appId: smoke.config.smokeAppId,
          flagId: createdFlag.id,
        });
      }
    }
  });

  test("updates seeded Flag Configuration and dry-runs Evaluation", async ({
    accessToken,
    smoke,
  }) => {
    const flag = await smoke.callTool<Flag>(accessToken, "flags_get", {
      appId: smoke.config.smokeAppId,
      flagId: smoke.config.smokeFlagId,
    });
    const treatment = variant(flag, "treatment");

    const config = await smoke.callTool<Record<string, unknown>>(
      accessToken,
      "flag_config_update",
      {
        appId: smoke.config.smokeAppId,
        environmentId: smoke.config.smokeEnvironmentId,
        flagId: smoke.config.smokeFlagId,
        enabled: true,
        availableVariantNames: ["control", "treatment"],
      },
    );
    expect(config).toMatchObject({
      flagId: smoke.config.smokeFlagId,
      environmentId: smoke.config.smokeEnvironmentId,
      enabled: true,
      availableVariantNames: ["control", "treatment"],
    });

    await smoke.callTool(accessToken, "flag_targeting_rules_replace", {
      appId: smoke.config.smokeAppId,
      environmentId: smoke.config.smokeEnvironmentId,
      flagId: smoke.config.smokeFlagId,
      targetingRules: [
        {
          id: smoke.uniqueKey("rule"),
          flagId: smoke.config.smokeFlagId,
          priority: 0,
          conditions: [{ attribute: "plan", operator: "eq", value: "pro" }],
          variantId: treatment.id,
          percentageRollout: null,
        },
      ],
    });

    const evaluation = await smoke.callTool<Record<string, unknown>>(
      accessToken,
      "flags_test_eval",
      {
        appId: smoke.config.smokeAppId,
        environmentId: smoke.config.smokeEnvironmentId,
        flagId: smoke.config.smokeFlagKey,
        evaluationContext: {
          targetingKey: smoke.uniqueKey("user"),
          idType: "user",
          attributes: { plan: "pro" },
        },
      },
    );

    expect(evaluation).toMatchObject({
      variantName: "treatment",
      value: true,
      liveRunId: null,
      reason: { type: "rule_matched" },
    });
  });
});

function variant(flag: Flag, name: string): { id: string; name: string; value: unknown } {
  const found = flag.variants.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`seeded smoke flag is missing Variant "${name}"`);
  }
  return found;
}
