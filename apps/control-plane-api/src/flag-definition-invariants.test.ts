import { createRepository, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appToken,
  baseFlag,
  createDefaultApp,
  createFlag,
  errorBody,
  type FlagDefinitionHarness,
  makeFlagDefinitionHarness,
  NOW_ISO,
  request,
} from "./flag-definition-test-harness";

let h: FlagDefinitionHarness;

beforeEach(async () => {
  h = await makeFlagDefinitionHarness();
});

afterEach(async () => h.bindings.dispose());

describe("control-plane Flag definition invariants", () => {
  it("rejects Variant values that violate the Flag schema", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);

    const wrongType = await request(h, "POST", `/apps/${createdApp.app.id}/flags`, jwt, {
      ...baseFlag(createdApp.app.id),
      variants: [
        { name: "control", value: false, isDefault: true },
        { name: "bad", value: "not-boolean", isDefault: false },
      ],
    });

    expect(wrongType.status).toBe(400);
    expect((await errorBody(wrongType)).code).toBe("VALIDATION_ERROR");

    const belowMinimum = await request(h, "POST", `/apps/${createdApp.app.id}/flags`, jwt, {
      ...baseFlag(createdApp.app.id),
      key: "discount-percent",
      schema: { type: "number", minimum: 0 },
      variants: [
        { name: "control", value: 0, isDefault: true },
        { name: "bad", value: -1, isDefault: false },
      ],
    });
    expect(belowMinimum.status).toBe(400);
    expect((await errorBody(belowMinimum)).code).toBe("VALIDATION_ERROR");
  });

  it("rejects unsupported schema keywords instead of ignoring them", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);

    const res = await request(h, "POST", `/apps/${createdApp.app.id}/flags`, jwt, {
      ...baseFlag(createdApp.app.id),
      key: "email-template",
      schema: { type: "string", format: "email" },
      variants: [
        { name: "control", value: "control@example.com", isDefault: true },
        { name: "treatment", value: "treatment@example.com", isDefault: false },
      ],
    });

    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe("VALIDATION_ERROR");
  });

  it("rejects no-default and multiple-default Variant catalogs", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);

    const noDefault = await request(h, "POST", `/apps/${createdApp.app.id}/flags`, jwt, {
      ...baseFlag(createdApp.app.id),
      key: "no-default",
      variants: [{ name: "control", value: false, isDefault: false }],
    });
    expect(noDefault.status).toBe(400);
    expect((await errorBody(noDefault)).code).toBe("VALIDATION_ERROR");

    const twoDefaults = await request(h, "POST", `/apps/${createdApp.app.id}/flags`, jwt, {
      ...baseFlag(createdApp.app.id),
      key: "two-defaults",
      variants: [
        { name: "control", value: false, isDefault: true },
        { name: "treatment", value: true, isDefault: true },
      ],
    });
    expect(twoDefaults.status).toBe(400);
    expect((await errorBody(twoDefaults)).code).toBe("VALIDATION_ERROR");
  });

  it("adds and deletes catalog Variants while blocking Environment-available Variants", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);

    const add = await request(
      h,
      "POST",
      `/apps/${createdApp.app.id}/flags/${flag.id}/variants`,
      jwt,
      {
        appId: createdApp.app.id,
        flagId: flag.id,
        name: "beta",
        value: true,
      },
    );
    expect(add.status).toBe(200);
    const withBeta = (await add.json()) as { variants: Array<{ name: string }> };
    expect(withBeta.variants.map((variant) => variant.name)).toContain("beta");

    const prod = createdApp.environments.find((env) => env.key === "prod");
    expect(prod).toBeDefined();
    await createRepository(h.bindings.d1).flags.updateFlagConfig(
      envScope(createdApp.app.id, prod?.id ?? ""),
      flag.id,
      { availableVariantNames: JSON.stringify(["beta"]) },
    );

    const blocked = await request(
      h,
      "DELETE",
      `/apps/${createdApp.app.id}/flags/${flag.id}/variants/beta`,
      jwt,
    );
    expect(blocked.status).toBe(409);
    expect((await errorBody(blocked)).code).toBe("RESOURCE_NOT_EMPTY");
  });
});

describe("control-plane Flag Variant updates", () => {
  it("updates catalog Variants and returns the full Flag definition response", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);

    const res = await request(
      h,
      "PATCH",
      `/apps/${createdApp.app.id}/flags/${flag.id}/variants/treatment`,
      jwt,
      { name: "beta", value: false, description: "renamed catalog entry" },
    );

    expect(res.status).toBe(200);
    const updated = (await res.json()) as {
      variants: Array<{ name: string; value: unknown; description?: string }>;
    };
    expect("enabled" in updated).toBe(false);
    expect(updated.variants).toContainEqual(
      expect.objectContaining({
        name: "beta",
        value: false,
        description: "renamed catalog entry",
      }),
    );
  });

  it("rejects duplicate names and schema-invalid values on Variant update", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);

    const duplicate = await request(
      h,
      "PATCH",
      `/apps/${createdApp.app.id}/flags/${flag.id}/variants/treatment`,
      jwt,
      { name: "control" },
    );
    expect(duplicate.status).toBe(400);
    expect((await errorBody(duplicate)).code).toBe("VALIDATION_ERROR");

    const wrongType = await request(
      h,
      "PATCH",
      `/apps/${createdApp.app.id}/flags/${flag.id}/variants/treatment`,
      jwt,
      { value: "not-boolean" },
    );
    expect(wrongType.status).toBe(400);
    expect((await errorBody(wrongType)).code).toBe("VALIDATION_ERROR");
  });

  it("rejects Variant value changes when a running Run includes the Variant", async () => {
    const createdApp = await createDefaultApp(h);
    const jwt = await appToken(h, createdApp.app.id);
    const flag = await createFlag(h, createdApp.app.id, jwt);
    const prod = createdApp.environments.find((env) => env.key === "prod");
    const treatment = flag.variants.find((variant) => variant.name === "treatment");
    expect(prod).toBeDefined();
    expect(treatment).toBeDefined();

    await seedRunningVariantRun(
      createdApp.app.id,
      prod?.id ?? "",
      flag.id,
      treatment ?? { id: "", name: "treatment", value: true },
    );

    const res = await request(
      h,
      "PATCH",
      `/apps/${createdApp.app.id}/flags/${flag.id}/variants/treatment`,
      jwt,
      { value: false },
    );

    expect(res.status).toBe(409);
    expect((await errorBody(res)).code).toBe("RUN_FROZEN");
  });
});

async function seedRunningVariantRun(
  appId: string,
  environmentId: string,
  flagId: string,
  variant: { id: string; name: string; value: unknown },
) {
  const repo = createRepository(h.bindings.d1);
  const scope = envScope(appId, environmentId);
  const experimentId = "exp_flag_variant_update_guard";
  const runId = "run_flag_variant_update_guard";
  await repo.experiments.experiments.insert(scope, {
    id: experimentId,
    appId,
    environmentId,
    key: "variant-update-guard",
    flagId,
    name: "Variant update guard",
    status: "running",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    metrics: "[]",
    guardrailMetrics: "[]",
    dimensions: "[]",
    liveRunId: runId,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  await repo.experiments.runs.insert(scope, {
    id: runId,
    appId,
    environmentId,
    experimentId,
    runNumber: 1,
    status: "running",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    salt: "salt_variant_update_guard",
    allocation: JSON.stringify({ control: 50, treatment: 50 }),
    variantSet: JSON.stringify([variant]),
    targetingRules: "[]",
    confidenceLevel: 0.95,
    decisionFamily: "[]",
    guardrailDecisions: "[]",
    configHash: "hash_variant_update_guard",
    startedAt: NOW_ISO,
    createdAt: NOW_ISO,
  });
}
