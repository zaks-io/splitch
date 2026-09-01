import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_API, EXIT_OK } from "./exit-codes.js";
import { FakeCliTransport, jsonError, oauthTokenMint, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

const timestamp = "2026-07-03T00:00:00.000Z";

async function configuredProject() {
  const home = await makeTempHome();
  await writeFile(home.credentialPath, `${JSON.stringify(storedCredential())}\n`);
  const cwd = join(home.dir, "project");
  await mkdir(cwd, { recursive: true });
  const configPath = join(cwd, "splitch.json");
  await writeFile(
    configPath,
    `${JSON.stringify({ version: 1, app: "app_previous", environment: "env_previous" })}\n`,
  );
  return { ...home, cwd, configPath };
}

describe("splitch use server-side selector validation", () => {
  it("validates each selector with one get and persists canonical IDs", async () => {
    const project = await configuredProject();
    const transport = new FakeCliTransport([
      oauthTokenMint(),
      {
        match: (request) => new URL(request.url).pathname === "/apps/checkout",
        status: 200,
        body: {
          id: "app_checkout",
          organizationId: "org_acme",
          key: "checkout",
          name: "Checkout",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
      {
        match: (request) => new URL(request.url).pathname === "/apps/app_checkout/envs/prod",
        status: 200,
        body: {
          id: "env_prod",
          appId: "app_checkout",
          key: "prod",
          name: "Production",
          policy: {
            variantAvailability: "allow",
            targetingRolloutValue: "allow",
            enabledState: "allow",
            startExperimentRun: "allow",
          },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    ]);

    const code = await runCli(["use", "--app", "checkout", "--env", "prod", "--json"], {
      credentialPath: project.credentialPath,
      cwd: project.cwd,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(
      transport.requests
        .filter((request) => new URL(request.url).pathname.startsWith("/apps/"))
        .map((request) => new URL(request.url).pathname),
    ).toEqual(["/apps/checkout", "/apps/app_checkout/envs/prod"]);
    expect(JSON.parse(await readFile(project.configPath, "utf8"))).toEqual({
      version: 1,
      app: "app_checkout",
      environment: "env_prod",
    });
  });

  it("fails at the named command and preserves config when the App does not exist", async () => {
    const project = await configuredProject();
    const transport = new FakeCliTransport([
      oauthTokenMint(),
      {
        match: (request) => new URL(request.url).pathname === "/apps/typoo",
        status: 404,
        body: jsonError("APP_NOT_FOUND", "app not found"),
      },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["use", "--app", "typoo", "--json"], {
      credentialPath: project.credentialPath,
      cwd: project.cwd,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_API);
    expect(error.mock.calls.join(" ")).toContain("APP_NOT_FOUND");
    expect(JSON.parse(await readFile(project.configPath, "utf8"))).toEqual({
      version: 1,
      app: "app_previous",
      environment: "env_previous",
    });
  });
});
