import { CreateFlagRequestSchema } from "@splitch/contracts";
import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { parseBooleanVariantsFlag } from "./flag-create-input.js";
import {
  authHeader,
  clientKeyMaterial,
  flagConfigResponse,
  FakeCliTransport,
  storedCredential,
  verifyResolutionDetails,
} from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

const quickstartCreateArgs = [
  "flags",
  "create",
  "--json",
  "--app",
  "app_1",
  "--key",
  "new-checkout",
  "--variants",
  "on,off",
] as const;

const createdFlag = {
  id: "flag_new_checkout",
  appId: "app_1",
  key: "new-checkout",
  name: "New Checkout",
  schema: { type: "boolean" },
  variants: [
    { id: "var_on", name: "on", value: true },
    { id: "var_off", name: "off", value: false },
  ],
  defaultVariantId: "var_off",
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
};

afterEach(async () => {
  await cleanupTempHomes();
});

describe("quickstart flag create drift", () => {
  it("parses the documented create command into a contract-valid request", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.includes("/apps/app_1/flags") && request.method === "POST",
        status: 200,
        body: createdFlag,
      },
    ]);

    const code = await runCli([...quickstartCreateArgs], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    const create = transport.requests.find(
      (request) => request.url.includes("/apps/app_1/flags") && request.method === "POST",
    );
    expect(create?.authorization).toBe(authHeader());
    expect(CreateFlagRequestSchema.safeParse(create?.body).success).toBe(true);
    expect(create?.body).toMatchObject({
      appId: "app_1",
      key: "new-checkout",
      name: "New Checkout",
      schema: { type: "boolean" },
      variants: parseBooleanVariantsFlag("on,off"),
    });
  });

  it("rejects ambiguous Variant input before any write", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([]);

    const code = await runCli(
      [
        "flags",
        "create",
        "--json",
        "--app",
        "app_1",
        "--key",
        "new-checkout",
        "--variants",
        "on,true",
      ],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_USAGE);
    expect(transport.requests).toHaveLength(0);
  });

  it("executes create, configure, and verify from the quickstart sequence", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.includes("/apps/app_1/flags") && request.method === "POST",
        status: 200,
        body: createdFlag,
      },
      {
        match: (request) => request.url.includes("/config") && request.method === "PATCH",
        status: 200,
        body: flagConfigResponse,
      },
      {
        match: (request) => request.url.includes("/client-key"),
        status: 200,
        body: {
          keyId: "ck_1",
          appId: "app_1",
          environmentId: "env_1",
          keyMaterial: clientKeyMaterial,
          isOriginOpen: true,
          createdAt: "2026-07-03T00:00:00.000Z",
        },
      },
      {
        match: (request) => request.url.includes("/api/sdk/verify"),
        status: 200,
        body: verifyResolutionDetails,
      },
    ]);

    const createCode = await runCli([...quickstartCreateArgs], {
      credentialPath,
      fetch: transport.fetch,
    });
    expect(createCode).toBe(EXIT_OK);

    const configureCode = await runCli(
      [
        "flag-config",
        "update",
        "--json",
        "--confirm",
        "--app",
        "app_1",
        "--env",
        "env_1",
        "flag_new_checkout",
        "--enabled",
        "true",
      ],
      { credentialPath, fetch: transport.fetch },
    );
    expect(configureCode).toBe(EXIT_OK);

    const verifyCode = await runCli(
      [
        "flags",
        "verify",
        "--json",
        "--app",
        "app_1",
        "--env",
        "env_1",
        "new-checkout",
        "--targeting-key",
        "test-user-1",
      ],
      { credentialPath, fetch: transport.fetch },
    );
    expect(verifyCode).toBe(EXIT_OK);

    const verifyCall = transport.requests.find((request) =>
      request.url.includes("/api/sdk/verify"),
    );
    expect(verifyCall?.body).toMatchObject({
      flagKey: "new-checkout",
      targetingKey: "test-user-1",
    });
  });
});
