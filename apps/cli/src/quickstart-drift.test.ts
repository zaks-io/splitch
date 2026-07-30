import { CreateFlagRequestSchema } from "@splitch/contracts";
import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.js";
import { parseBooleanVariantsFlag } from "./flag-create-input.js";
import {
  findFlagByKey,
  makeQuickstartHarness,
  quickstartOrigins,
  readConfigRollout,
  storedHarnessCredential,
  type QuickstartHarness,
} from "./quickstart-local-harness.js";
import { authHeader, FakeCliTransport, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

const quickstartCreateArgs = [
  "flags",
  "create",
  "--json",
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

    const code = await runCli([...quickstartCreateArgs, "--app", "app_1"], {
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

  it('rejects a --rollout that is neither a 0-100 number nor "none"', async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([]);

    const code = await runCli(
      ["flag-config", "update", "--json", "--app", "app_1", "flag_1", "--rollout", "110"],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_USAGE);
    expect(transport.requests).toHaveLength(0);
  });
});

// Scoped to this block, not the whole file: these tests drive a real
// CLI-to-control-plane lifecycle against the harness, so they are the only ones
// here whose honest runtime is near vitest's 5s default. They take ~1-3s
// locally but roughly 3x that on a contended CI runner, which is close enough
// to fail on scheduling alone. Every other suite in this package keeps the
// default, where a 5s overrun really does mean something hung.
describe("quickstart local control-plane lifecycle", { timeout: 60_000 }, () => {
  let harness: QuickstartHarness;

  beforeEach(async () => {
    harness = await makeQuickstartHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("executes create, configure dev, promote prod, and verify prod from the quickstart sequence", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedHarnessCredential(harness))}\n`);
    const cliOptions = {
      credentialPath,
      fetch: harness.routingFetch,
      controlPlaneBaseUrl: quickstartOrigins.controlPlaneBaseUrl,
      evaluationBaseUrl: quickstartOrigins.evaluationBaseUrl,
    };

    const createCode = await runCli([...quickstartCreateArgs, "--app", harness.appId], cliOptions);
    expect(createCode).toBe(EXIT_OK);

    const flag = await findFlagByKey(harness, "new-checkout");

    const configureCode = await runCli(
      [
        "flag-config",
        "update",
        "--json",
        "--app",
        harness.appId,
        "--env",
        harness.devEnvironmentId,
        flag.id,
        "--enabled",
        "true",
        "--body-json",
        JSON.stringify({ availableVariantNames: ["on", "off"] }),
      ],
      cliOptions,
    );
    expect(configureCode).toBe(EXIT_OK);

    const promoteCode = await runCli(
      [
        "flags",
        "promote",
        "--json",
        "--confirm",
        "--app",
        harness.appId,
        "--env",
        harness.prodEnvironmentId,
        flag.id,
        "--from-environment-id",
        harness.devEnvironmentId,
      ],
      cliOptions,
    );
    expect(promoteCode).toBe(EXIT_OK);

    const verifyCode = await runCli(
      [
        "flags",
        "verify",
        "--json",
        "--app",
        harness.appId,
        "--env",
        harness.prodEnvironmentId,
        "new-checkout",
        "--targeting-key",
        "test-user-1",
      ],
      cliOptions,
    );
    expect(verifyCode).toBe(EXIT_OK);
  });

  it("sets and widens the documented baseline rollout, keeping the server-minted salt", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedHarnessCredential(harness))}\n`);
    const cliOptions = {
      credentialPath,
      fetch: harness.routingFetch,
      controlPlaneBaseUrl: quickstartOrigins.controlPlaneBaseUrl,
      evaluationBaseUrl: quickstartOrigins.evaluationBaseUrl,
    };

    const createCode = await runCli([...quickstartCreateArgs, "--app", harness.appId], cliOptions);
    expect(createCode).toBe(EXIT_OK);
    const flag = await findFlagByKey(harness, "new-checkout");

    const rollout = async (percentage: string) => {
      const code = await runCli(
        [
          "flag-config",
          "update",
          "--json",
          "--app",
          harness.appId,
          "--env",
          harness.devEnvironmentId,
          flag.id,
          "--rollout",
          percentage,
        ],
        cliOptions,
      );
      expect(code).toBe(EXIT_OK);
      return await readConfigRollout(harness, flag.id, harness.devEnvironmentId);
    };

    const minted = await rollout("10");
    expect(minted).toMatchObject({ percentage: 10, salt: expect.any(String) });

    // The quickstart promises widening is safe; that promise is only true if the
    // salt survives, so assert it here rather than trusting the prose.
    expect(await rollout("25")).toEqual({ percentage: 25, salt: minted?.salt });
  });
});
