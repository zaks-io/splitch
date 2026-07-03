import { deriveMcpTools, getRoute } from "@splitch/contracts";
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
} from "./flag-definition-test-harness.js";

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
    await createRepository(h.bindings.d1).flags.flagConfigs.insert(
      envScope(createdApp.app.id, prod?.id ?? ""),
      {
        id: "cfg_flag_definition_guard",
        appId: createdApp.app.id,
        environmentId: prod?.id ?? "",
        flagId: flag.id,
        enabled: false,
        availableVariantNames: JSON.stringify(["beta"]),
        defaultVariantId: flag.defaultVariantId,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
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

  it("derives flags_create and flag_variants_create MCP tools from the same routes", () => {
    const tools = deriveMcpTools();
    for (const operationId of ["flags_create", "flag_variants_create"] as const) {
      const route = getRoute(operationId);
      const tool = tools.find((candidate) => candidate.name === operationId);
      const body = route?.openapi.request?.body?.content?.["application/json"]?.schema;
      expect(route).toBeDefined();
      expect(tool).toBeDefined();
      expect(tool?.inputSchema).toBe(body);
      expect(tool?.outputSchema).toBe(route?.output);
    }
  });
});
