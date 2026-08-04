import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import {
  authHeader,
  FakeCliTransport,
  flagRecord,
  oauthTokenMint,
  organizationUsage,
  storedCredential,
  testEvaluation,
} from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  await cleanupTempHomes();
});

const createArgs = [
  "flags",
  "create",
  "--json",
  "--app",
  "app_1",
  "--key",
  "checkout",
  "--variants",
  "on,off",
] as const;

function controlPlaneTransport(): FakeCliTransport {
  return new FakeCliTransport([
    ...scopeResolutionStubs(),
    {
      match: (request) => request.url.includes("/flags") && request.method === "POST",
      status: 200,
      body: flagRecord,
    },
  ]);
}

describe("platform target and API origins", () => {
  it("defaults to hosted production origins", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = controlPlaneTransport();

    const code = await runCli([...createArgs], { credentialPath, fetch: transport.fetch, env: {} });
    expect(code).toBe(EXIT_OK);
    const create = transport.requests.find(
      (request) => request.url.includes("/flags") && request.method === "POST",
    );
    expect(create?.url.startsWith("https://api.splitch.dev/")).toBe(true);
    expect(create?.authorization).toBe(authHeader());
  });

  // Every operation the CLI holds a control-plane token for is addressed at the
  // control-plane origin, whichever Worker implements it (ADR-0046). Both of
  // these used to leak their implementation owner into the client: Organization
  // usage went to a hostname that did not exist, test-eval went to the
  // data-plane edge.
  it.each([
    {
      name: "an Analysis-implemented command",
      args: ["organization-usage", "get", "org_1", "--json"],
      path: "/orgs/org_1/usage",
      body: organizationUsage,
    },
    {
      name: "an Evaluation-implemented command",
      args: [
        "flags",
        "test-eval",
        "checkout",
        "--app",
        "app_1",
        "--env",
        "env_1",
        "--targeting-key",
        "user-123",
        "--json",
      ],
      path: "/apps/app_1/envs/env_1/flags/checkout/test-eval",
      body: testEvaluation,
    },
  ])("routes $name to the control-plane origin", async ({ args, path, body }) => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      oauthTokenMint(),
      { match: (request) => request.url.includes(path), status: 200, body },
    ]);

    const code = await runCli(args, { credentialPath, fetch: transport.fetch, env: {} });

    expect(code).toBe(EXIT_OK);
    expect(transport.requests.find((request) => request.url.includes(path))?.url).toBe(
      `https://api.splitch.dev${path}`,
    );
  });

  it("SPLITCH_PLATFORM_TARGET=local routes to the local dev stack", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = controlPlaneTransport();

    const code = await runCli([...createArgs], {
      credentialPath,
      fetch: transport.fetch,
      env: { SPLITCH_PLATFORM_TARGET: "local" },
    });
    expect(code).toBe(EXIT_OK);
    expect(
      transport.requests
        .find((request) => request.url.includes("/flags") && request.method === "POST")
        ?.url.startsWith("http://127.0.0.1:8787/"),
    ).toBe(true);
  });

  it("CONTROL_PLANE_API_ORIGIN overrides the baked default", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = controlPlaneTransport();

    const code = await runCli([...createArgs], {
      credentialPath,
      fetch: transport.fetch,
      env: { CONTROL_PLANE_API_ORIGIN: "https://env.example" },
    });
    expect(code).toBe(EXIT_OK);
    expect(
      transport.requests
        .find((request) => request.url.includes("/flags") && request.method === "POST")
        ?.url.startsWith("https://env.example/"),
    ).toBe(true);
  });

  it("explicit options win over environment origins", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = controlPlaneTransport();

    const code = await runCli([...createArgs], {
      credentialPath,
      fetch: transport.fetch,
      controlPlaneBaseUrl: "https://option.example",
      env: { CONTROL_PLANE_API_ORIGIN: "https://env.example" },
    });
    expect(code).toBe(EXIT_OK);
    expect(
      transport.requests
        .find((request) => request.url.includes("/flags") && request.method === "POST")
        ?.url.startsWith("https://option.example/"),
    ).toBe(true);
  });

  it("rejects an invalid SPLITCH_PLATFORM_TARGET instead of falling back to local", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const code = await runCli([...createArgs], {
        credentialPath,
        fetch: transport.fetch,
        env: { SPLITCH_PLATFORM_TARGET: "prod" },
      });
      expect(code).not.toBe(EXIT_OK);
      expect(transport.requests).toHaveLength(0);
      const output = errorSpy.mock.calls.flat().join("\n");
      expect(output).toContain("CLI_VALIDATION_ERROR");
      expect(output).toContain("production");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("fails loud when the selected target has no origin for the route", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const code = await runCli([...createArgs], {
        credentialPath,
        fetch: transport.fetch,
        env: { SPLITCH_PLATFORM_TARGET: "shared-preview" },
      });
      expect(code).not.toBe(EXIT_OK);
      expect(transport.requests).toHaveLength(0);
      const output = errorSpy.mock.calls.flat().join("\n");
      expect(output).toContain("CLI_API_ORIGIN_MISSING");
      expect(output).toContain("CONTROL_PLANE_API_ORIGIN");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
