import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KILL_SWITCH_OFF_EXEMPTION } from "@splitch/sdk/control-plane";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_API, EXIT_OK } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, jsonError, storedCredential } from "./test-fixtures.js";
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

describe("env-policy get server-side selector resolution", () => {
  it("forwards --env prod with a config-stored App ID", async () => {
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
          request.method === "GET" && new URL(request.url).pathname === "/apps/app_1/envs/prod",
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
        (request) => new URL(request.url).pathname === "/apps/app_1/envs/prod",
      ),
    ).toBe(true);
  });

  it("returns the server-resolved Environment policy", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) =>
          request.method === "GET" && new URL(request.url).pathname === "/apps/app_1/envs/prod",
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
        (request) => new URL(request.url).pathname === "/apps/app_1/envs/prod",
      ),
    ).toBe(true);
  });
});

describe("env-policy canonical selector recovery", () => {
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
      ["env-policy", "get", "--json", "--app", "app_1", "--env", "env_prod", "--by", "id"],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_OK);
    const request = transport.requests.find(
      (item) => new URL(item.url).pathname === "/apps/app_1/envs/env_prod",
    );
    expect(new URL(request?.url ?? "https://invalid.test").searchParams.get("by")).toBe("id");
  });

  it("forwards by=id on env-policy set without leaking it into the Policy body", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) =>
          request.method === "PATCH" &&
          new URL(request.url).pathname === "/apps/app_1/envs/env_prod",
        status: 200,
        body: environmentGetBody,
      },
    ]);

    const code = await runCli(
      [
        "env-policy",
        "set",
        "--json",
        "--app",
        "app_1",
        "--env",
        "env_prod",
        "--by",
        "id",
        "--body-json",
        JSON.stringify(envPolicy),
      ],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_OK);
    const request = transport.requests.find((item) => item.method === "PATCH");
    expect(new URL(request?.url ?? "https://invalid.test").searchParams.get("by")).toBe("id");
    expect(request?.body).toEqual({ policy: envPolicy });
  });

  it("lets the server refuse an unknown Environment", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) => new URL(request.url).pathname === "/apps/app_1/envs/nosuch",
        status: 404,
        body: jsonError("APP_NOT_FOUND", "app not found"),
      },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(
      ["env-policy", "get", "--json", "--app", "app_1", "--env", "nosuch"],
      {
        credentialPath,
        fetch: transport.fetch,
      },
    );

    expect(code).toBe(EXIT_API);
    const message = error.mock.calls.join(" ");
    expect(message).toContain("APP_NOT_FOUND");
    expect(message).not.toContain("CLI_SCOPE_UNRESOLVED");
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
          request.method === "GET" && new URL(request.url).pathname === "/apps/app_1/envs/prod",
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
