import { writeFile } from "node:fs/promises";
import { experimentResourceFixture } from "@splitch/contracts/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

describe("body-only flagId is not resolved", () => {
  it("leaves experiments create --body-json flagId alone (no :flagId route param)", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname === "/apps/app_1/envs/env_1/experiments",
        status: 200,
        body: experimentResourceFixture({
          id: "exp_1",
          appId: "app_1",
          environmentId: "env_1",
          key: "checkout-exp",
          flagId: "checkout-banner",
          name: "Checkout exp",
          defaultVariantId: "var_on",
        }),
      },
    ]);

    const code = await runCli(
      [
        "experiments",
        "create",
        "--json",
        "--app",
        "app_1",
        "--env",
        "env_1",
        "--body-json",
        JSON.stringify({
          key: "checkout-exp",
          name: "Checkout exp",
          flagId: "checkout-banner",
          targetingKey: "userId",
          targetingKeyType: "user",
          metrics: [],
        }),
      ],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_OK);
    expect(
      transport.requests.some(
        (request) =>
          request.method === "GET" && new URL(request.url).pathname === "/apps/app_1/flags",
      ),
    ).toBe(false);
    const create = transport.requests.find(
      (request) =>
        request.method === "POST" &&
        new URL(request.url).pathname === "/apps/app_1/envs/env_1/experiments",
    );
    expect(create?.body).toMatchObject({ flagId: "checkout-banner" });
  });
});
