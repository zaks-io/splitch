import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_API, EXIT_OK } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, jsonError, promoteResponse, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

describe("flags promote server-side selector resolution", () => {
  it("forwards a target Environment selector unchanged", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) =>
          request.method === "POST" &&
          request.url.includes("/apps/app_1/envs/prod/flags/flag_1/promote"),
        status: 200,
        body: promoteResponse,
      },
    ]);

    const code = await runCli(
      [
        "flags",
        "promote",
        "--json",
        "--confirm",
        "--app",
        "app_1",
        "--env",
        "prod",
        "flag_1",
        "--from-environment-id",
        "env_1",
      ],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_OK);
    expect(
      transport.requests.some((request) =>
        request.url.includes("/apps/app_1/envs/prod/flags/flag_1/promote"),
      ),
    ).toBe(true);
  });

  it("accepts a canonical target Environment ID", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) =>
          request.method === "POST" &&
          request.url.includes("/apps/app_1/envs/env_prod/flags/flag_1/promote"),
        status: 200,
        body: promoteResponse,
      },
    ]);

    const code = await runCli(
      [
        "flags",
        "promote",
        "--json",
        "--confirm",
        "--app",
        "app_1",
        "--env",
        "env_prod",
        "flag_1",
        "--from-environment-id",
        "env_1",
      ],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_OK);
  });

  it("lets the server refuse an unknown target Environment", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) => request.url.includes("/apps/app_1/envs/nosuch/flags/flag_1/promote"),
        status: 404,
        body: jsonError("APP_NOT_FOUND", "app not found"),
      },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(
      [
        "flags",
        "promote",
        "--json",
        "--confirm",
        "--app",
        "app_1",
        "--env",
        "nosuch",
        "flag_1",
        "--from-environment-id",
        "env_1",
      ],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_API);
    const message = error.mock.calls.join(" ");
    expect(message).toContain("APP_NOT_FOUND");
    expect(message).not.toContain("CLI_SCOPE_UNRESOLVED");
    expect(transport.requests.some((request) => request.url.includes("/promote"))).toBe(true);
  });
});

describe("flags list --app slug resolution", () => {
  it("lets the server refuse an unknown App selector", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) => new URL(request.url).pathname === "/apps/missing-app/flags",
        status: 404,
        body: jsonError("APP_NOT_FOUND", "app not found"),
      },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["flags", "list", "--json", "--app", "missing-app"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_API);
    const message = error.mock.calls.join(" ");
    expect(message).toContain("APP_NOT_FOUND");
    expect(message).not.toContain("CLI_SCOPE_UNRESOLVED");
  });
});
