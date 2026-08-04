import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK, EXIT_SCOPE } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, flagConfigResponse, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

const FLAG_1 = [{ id: "flag_1", key: "flag-1", name: "Flag 1" }] as const;

describe("flag-config get --app/--env slug resolution", () => {
  it("accepts an Environment slug and calls the API with the canonical ID", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs({ appKey: "cold-test-app", flags: FLAG_1 }),
      {
        match: (request) =>
          request.method === "GET" &&
          request.url.includes("/apps/app_1/envs/env_prod/flags/flag_1/config"),
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
        request.url.includes("/apps/app_1/envs/env_prod/flags/flag_1/config"),
      ),
    ).toBe(true);
  });

  it("accepts canonical App and Environment IDs", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs({ flags: FLAG_1 }),
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

  it("fails with CLI_SCOPE_UNRESOLVED naming the unknown Environment slug", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    // Env fails before Flag resolution, so no flags stub is required.
    const transport = new FakeCliTransport([...scopeResolutionStubs()]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(
      ["flag-config", "get", "--json", "--app", "app_1", "--env", "nosuch", "flag_1"],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_SCOPE);
    const message = error.mock.calls.join(" ");
    expect(message).toContain("CLI_SCOPE_UNRESOLVED");
    expect(message).toContain("nosuch");
    expect(message).not.toContain("FLAG_NOT_FOUND");
    expect(transport.requests.some((request) => request.url.includes("/flags/flag_1/config"))).toBe(
      false,
    );
  });
});
