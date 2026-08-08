import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KILL_SWITCH_OFF_EXEMPTION } from "@splitch/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK, EXIT_SCOPE } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

const envPolicy = {
  variantAvailability: "allow",
  targetingRolloutValue: "allow",
  enabledState: "allow",
  startExperimentRun: "allow",
};

const environmentGetBody = {
  id: "env_prod",
  appId: "app_1",
  key: "prod",
  name: "Prod",
  policy: envPolicy,
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
};

describe("env-policy get --app/--env slug resolution", () => {
  it("resolves --env prod against a config-stored App ID", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const configDir = join(dir, "project");
    await mkdir(join(configDir, ".splitch"), { recursive: true });
    await writeFile(
      join(configDir, ".splitch", "config.json"),
      '{"version":1,"app":"app_1","environment":"env_1"}\n',
    );
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) =>
          request.method === "GET" && new URL(request.url).pathname === "/apps/app_1/envs/env_prod",
        status: 200,
        body: environmentGetBody,
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["env-policy", "get", "--json", "--env", "prod"], {
      credentialPath,
      cwd: configDir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(log.mock.calls.join(""))).toEqual({ policy: envPolicy });
    expect(
      transport.requests.some(
        (request) => new URL(request.url).pathname === "/apps/app_1/envs/env_prod",
      ),
    ).toBe(true);
  });

  it("accepts an Environment slug and returns the policy for the resolved ID", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) =>
          request.method === "GET" && new URL(request.url).pathname === "/apps/app_1/envs/env_prod",
        status: 200,
        body: environmentGetBody,
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["env-policy", "get", "--json", "--app", "app_1", "--env", "prod"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(log.mock.calls.join(""))).toEqual({ policy: envPolicy });
    expect(
      transport.requests.some(
        (request) => new URL(request.url).pathname === "/apps/app_1/envs/env_prod",
      ),
    ).toBe(true);
  });

  it("accepts a canonical Environment ID", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) =>
          request.method === "GET" && new URL(request.url).pathname === "/apps/app_1/envs/env_prod",
        status: 200,
        body: environmentGetBody,
      },
    ]);

    const code = await runCli(
      ["env-policy", "get", "--json", "--app", "app_1", "--env", "env_prod"],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_OK);
  });

  it("fails with CLI_SCOPE_UNRESOLVED naming the unknown Environment slug", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([...scopeResolutionStubs()]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(
      ["env-policy", "get", "--json", "--app", "app_1", "--env", "nosuch"],
      {
        credentialPath,
        fetch: transport.fetch,
      },
    );

    expect(code).toBe(EXIT_SCOPE);
    const message = error.mock.calls.join(" ");
    expect(message).toContain("CLI_SCOPE_UNRESOLVED");
    expect(message).toContain("nosuch");
    expect(message).toContain("app_1");
    expect(message).not.toContain("APP_NOT_FOUND");
  });

  it("states the kill-switch-off exemption when enabledState is confirm (SPL-312)", async () => {
    const confirmPolicy = {
      variantAvailability: "confirm",
      targetingRolloutValue: "confirm",
      enabledState: "confirm",
      startExperimentRun: "confirm",
    };
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) =>
          request.method === "GET" && new URL(request.url).pathname === "/apps/app_1/envs/env_prod",
        status: 200,
        body: { ...environmentGetBody, policy: confirmPolicy },
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["env-policy", "get", "--app", "app_1", "--env", "prod"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("enabledState: confirm");
    expect(output).toContain(KILL_SWITCH_OFF_EXEMPTION);
  });
});
