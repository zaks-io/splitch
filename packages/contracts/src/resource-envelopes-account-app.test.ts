import { describe, expect, it } from "vitest";
import { CreateAppResponseSchema } from "./resource-envelopes-account.js";

const timestamp = "2026-06-28T00:00:00.000Z";

const allowPolicy = {
  variantAvailability: "allow",
  targetingRolloutValue: "allow",
  enabledState: "allow",
  startExperimentRun: "allow",
} as const;

const confirmPolicy = {
  variantAvailability: "confirm",
  targetingRolloutValue: "confirm",
  enabledState: "confirm",
  startExperimentRun: "confirm",
} as const;

const app = {
  id: "app_1",
  organizationId: "org_1",
  name: "Checkout",
  key: "checkout",
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe("CreateAppResponseSchema", () => {
  it("surfaces the default Environments and public Client Keys for the new App", () => {
    const res = CreateAppResponseSchema.parse({
      app,
      environments: [
        environment("env_dev", "dev", "Dev", allowPolicy),
        environment("env_prod", "prod", "Prod", confirmPolicy),
      ],
      clientKeys: [
        clientKey("ck_dev", "env_dev", "pk_dev"),
        clientKey("ck_prod", "env_prod", "pk_prod"),
      ],
    });
    expect(res.environments.map((env) => env.key)).toEqual(["dev", "prod"]);
    expect(res.clientKeys.map((key) => key.environmentId)).toEqual(["env_dev", "env_prod"]);
  });

  it("rejects the stale API Key creation shape", () => {
    expect(
      CreateAppResponseSchema.safeParse({
        app,
        environmentId: "env_dev",
        apiKey: { id: "ak_1", value: "sk_raw_secret" },
        clientKey: { id: "ck_1", value: "pk_public" },
      }).success,
    ).toBe(false);
  });
});

function environment(
  id: string,
  key: string,
  name: string,
  policy: typeof allowPolicy | typeof confirmPolicy,
) {
  return {
    id,
    appId: app.id,
    key,
    name,
    policy,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function clientKey(keyId: string, environmentId: string, keyMaterial: string) {
  return {
    keyId,
    appId: app.id,
    environmentId,
    keyMaterial,
    isOriginOpen: true,
    createdAt: timestamp,
  };
}
