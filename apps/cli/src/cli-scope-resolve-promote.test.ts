import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK, EXIT_SCOPE } from "./exit-codes.js";
import { flagsListStub, scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, promoteResponse, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

const FLAG_1 = [{ id: "flag_1", key: "flag-1", name: "Flag 1" }] as const;

describe("flags promote --env slug resolution", () => {
  it("accepts a target Environment slug and promotes to the canonical ID", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsListStub({ flags: FLAG_1 }),
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
        request.url.includes("/apps/app_1/envs/env_prod/flags/flag_1/promote"),
      ),
    ).toBe(true);
  });

  it("accepts a canonical target Environment ID", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsListStub({ flags: FLAG_1 }),
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

  it("fails with CLI_SCOPE_UNRESOLVED naming the unknown target Environment slug", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([...scopeResolutionStubs()]);
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

    expect(code).toBe(EXIT_SCOPE);
    const message = error.mock.calls.join(" ");
    expect(message).toContain("CLI_SCOPE_UNRESOLVED");
    expect(message).toContain("nosuch");
    expect(transport.requests.some((request) => request.url.includes("/promote"))).toBe(false);
  });
});

describe("flags list --app slug resolution", () => {
  it("fails with CLI_SCOPE_UNRESOLVED naming an unknown App slug", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([...scopeResolutionStubs()]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["flags", "list", "--json", "--app", "missing-app"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_SCOPE);
    const message = error.mock.calls.join(" ");
    expect(message).toContain("CLI_SCOPE_UNRESOLVED");
    expect(message).toContain("missing-app");
    expect(message).not.toContain("FORBIDDEN");
  });
});
