import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_API, EXIT_OK } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import {
  FakeCliTransport,
  flagConfigResponse,
  jsonError,
  storedCredential,
} from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

describe("flag-config get --app/--env slug resolution", () => {
  it("forwards App and Environment selectors unchanged", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs({ appKey: "cold-test-app" }),
      {
        match: (request) =>
          request.method === "GET" &&
          request.url.includes("/apps/cold-test-app/envs/prod/flags/flag_1/config"),
        status: 200,
        body: flagConfigResponse,
      },
    ]);

    const code = await runCli(
      ["flag-config", "get", "--json", "--app", "cold-test-app", "--env", "prod", "flag_1"],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_OK);
    expect(
      transport.requests.some((request) =>
        request.url.includes("/apps/cold-test-app/envs/prod/flags/flag_1/config"),
      ),
    ).toBe(true);
  });

  it("accepts canonical App and Environment IDs", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) =>
          request.method === "GET" &&
          request.url.includes("/apps/app_1/envs/env_prod/flags/flag_1/config"),
        status: 200,
        body: flagConfigResponse,
      },
    ]);

    const code = await runCli(
      ["flag-config", "get", "--json", "--app", "app_1", "--env", "env_prod", "flag_1"],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_OK);
  });

  it("lets the server refuse an unknown Environment", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) => request.url.includes("/apps/app_1/envs/nosuch/flags/flag_1/config"),
        status: 404,
        body: jsonError("APP_NOT_FOUND", "app not found"),
      },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(
      ["flag-config", "get", "--json", "--app", "app_1", "--env", "nosuch", "flag_1"],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_API);
    const message = error.mock.calls.join(" ");
    expect(message).toContain("APP_NOT_FOUND");
    expect(message).not.toContain("CLI_SCOPE_UNRESOLVED");
    expect(transport.requests.some((request) => request.url.includes("/flags/flag_1/config"))).toBe(
      true,
    );
  });

  it("forwards a Flag key before the config GET", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) =>
          request.method === "GET" &&
          request.url.includes("/apps/app_1/envs/env_prod/flags/checkout-banner/config"),
        status: 200,
        body: { ...flagConfigResponse, flagId: "flag_checkout_banner" },
      },
    ]);

    const code = await runCli(
      ["flag-config", "get", "--json", "--app", "app_1", "--env", "env_prod", "checkout-banner"],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_OK);
    expect(
      transport.requests.some((request) =>
        request.url.includes("/apps/app_1/envs/env_prod/flags/checkout-banner/config"),
      ),
    ).toBe(true);
  });
});
