import { appScope, createRepository, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allowAllPolicies,
  appToken,
  baseFlag,
  createDefaultApp,
  createFlag,
  type FlagDefinitionHarness,
  makeFlagDefinitionHarness,
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
    jwt: await appToken(h, created.app.id),
    environments: created.environments,
  };
}

describe("flag_removal_brief", () => {
  it("returns an advisory brief with SDK shapes and configuration-unverified servings", async () => {
    const { appId, jwt } = await ownerSession();
    const flag = await createFlag(h, appId, jwt, {
      ...baseFlag(appId),
      key: "new-checkout",
      name: "New Checkout",
      lifecycleClass: "release",
      owner: "checkout-team",
      expiresAt: "2026-12-31T00:00:00.000Z",
    });

    const res = await request(h, "GET", `/apps/${appId}/flags/${flag.id}/removal-brief`, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      flagKey: string;
      removalSafe: boolean;
      keepVariant: string | null;
      sdkCallShapes: string[];
      caveats: string[];
      environments: Array<{ servingEvidence: string; configurationServedVariant: string | null }>;
    };
    expect(body.flagKey).toBe("new-checkout");
    expect(body.sdkCallShapes).toContain('evaluate("new-checkout"');
    expect(body.caveats.some((c) => c.includes("never writes"))).toBe(true);
    expect(body.environments.length).toBeGreaterThan(0);
    expect(
      body.environments.every((env) => env.servingEvidence === "configuration_unverified"),
    ).toBe(true);
    // Fresh Flags start disabled on the Default Variant in every Environment.
    expect(body.removalSafe).toBe(true);
    expect(body.keepVariant).toBe("control");
  });

  it("keeps disabled Environments on their Default Variant despite a retained 100% rollout", async () => {
    const { appId, jwt, environments } = await ownerSession();
    await allowAllPolicies(h, appId);
    const flag = await createFlag(h, appId, jwt, {
      ...baseFlag(appId),
      key: "disabled-rollout",
      lifecycleClass: "ops",
    });
    const prod = environments.find((environment) => environment.key === "prod");
    if (!prod) throw new Error("expected prod Environment");
    const control = flag.variants.find((variant) => variant.name === "control");
    if (!control) throw new Error("expected control Variant");

    // Plant a disabled Configuration that still retains a 100% baseline rollout.
    // Evaluation serves the Environment Default Variant; the brief must match.
    const repo = createRepository(h.bindings.d1);
    const updated = await repo.flags.updateFlagConfig(envScope(appId, prod.id), flag.id, {
      enabled: false,
      availableVariantNames: JSON.stringify(["control", "treatment"]),
      defaultVariantId: control.id,
      rollout: JSON.stringify({ percentage: 100, salt: "disabled-rollout-salt" }),
      updatedAt: new Date().toISOString(),
    });
    expect(updated).toBeTruthy();

    const res = await request(h, "GET", `/apps/${appId}/flags/${flag.id}/removal-brief`, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      environments: Array<{
        environmentKey: string;
        configurationServedVariant: string | null;
        enabled: boolean;
      }>;
      removalSafe: boolean;
      keepVariant: string | null;
    };
    const prodServing = body.environments.find((env) => env.environmentKey === "prod");
    expect(prodServing).toMatchObject({
      enabled: false,
      configurationServedVariant: "control",
    });
    expect(body.removalSafe).toBe(true);
    expect(body.keepVariant).toBe("control");
  });

  it("uses per-Environment defaultVariantId after a Flag default change", async () => {
    const { appId, jwt, environments } = await ownerSession();
    await allowAllPolicies(h, appId);
    const flag = await createFlag(h, appId, jwt, {
      ...baseFlag(appId),
      key: "default-drift",
      lifecycleClass: "ops",
    });
    const control = flag.variants.find((variant) => variant.name === "control");
    const treatment = flag.variants.find((variant) => variant.name === "treatment");
    if (!control || !treatment) throw new Error("expected control and treatment Variants");

    // Flag-level default change does not rewrite existing Environment defaults.
    const repo = createRepository(h.bindings.d1);
    await repo.flags.updateFlag(appScope(appId), flag.id, {
      defaultVariantId: treatment.id,
      updatedAt: new Date().toISOString(),
    });

    const staging = await request(h, "POST", `/apps/${appId}/envs`, jwt, {
      key: "staging",
      name: "Staging",
    });
    expect(staging.status).toBe(200);
    const stagingEnv = (await staging.json()) as { id: string };

    const dev = environments.find((environment) => environment.key === "dev");
    if (!dev) throw new Error("expected dev Environment");
    const existingConfig = await repo.flags.getFlagConfig(envScope(appId, dev.id), flag.id);
    const stagingConfig = await repo.flags.getFlagConfig(envScope(appId, stagingEnv.id), flag.id);
    expect(existingConfig?.defaultVariantId).toBe(control.id);
    expect(stagingConfig?.defaultVariantId).toBe(treatment.id);

    const res = await request(h, "GET", `/apps/${appId}/flags/${flag.id}/removal-brief`, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      removalSafe: boolean;
      keepVariant: string | null;
      environments: Array<{ environmentKey: string; configurationServedVariant: string | null }>;
    };
    const byKey = new Map(
      body.environments.map((env) => [env.environmentKey, env.configurationServedVariant]),
    );
    expect(byKey.get("staging")).toBe("treatment");
    expect(byKey.get("dev")).toBe("control");
    expect(body.removalSafe).toBe(false);
    expect(body.keepVariant).toBeNull();
  });
});
