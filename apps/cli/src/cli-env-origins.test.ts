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
});

describe("ambient API origin overrides", () => {
  it("rejects an arbitrary production origin before any request", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = controlPlaneTransport();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runCli([...createArgs], {
      credentialPath,
      fetch: transport.fetch,
      env: { CONTROL_PLANE_API_ORIGIN: "https://env.example" },
    });
    expect(code).not.toBe(EXIT_OK);
    expect(transport.requests).toHaveLength(0);
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("CLI_VALIDATION_ERROR");
  });

  it("explicit options win over environment origins", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = controlPlaneTransport();

    const code = await runCli([...createArgs], {
      credentialPath,
      fetch: transport.fetch,
      controlPlaneBaseUrl: "https://api.splitch.dev",
      env: { CONTROL_PLANE_API_ORIGIN: "https://env.example" },
    });
    expect(code).toBe(EXIT_OK);
    expect(
      transport.requests
        .find((request) => request.url.includes("/flags") && request.method === "POST")
        ?.url.startsWith("https://api.splitch.dev/"),
    ).toBe(true);
  });

  it("rejects an arbitrary programmatic origin before any request", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = controlPlaneTransport();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli([...createArgs], {
      credentialPath,
      fetch: transport.fetch,
      controlPlaneBaseUrl: "https://option.example",
      env: {},
    });

    expect(code).not.toBe(EXIT_OK);
    expect(transport.requests).toHaveLength(0);
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
});

describe("platform origin boundaries", () => {
  it("uses the fixed shared-preview origin without an override", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = controlPlaneTransport();
    const code = await runCli([...createArgs], {
      credentialPath,
      fetch: transport.fetch,
      env: { SPLITCH_PLATFORM_TARGET: "shared-preview" },
    });
    expect(code).toBe(EXIT_OK);
    expect(
      transport.requests.some((request) =>
        request.url.startsWith("https://api.preview.splitch.dev/"),
      ),
    ).toBe(true);
  });

  it.each([
    "http://api.splitch.dev",
    "https://user:password@api.splitch.dev",
    "https://api.splitch.dev/path",
    "https://unrelated.example",
  ])("rejects unsafe hosted origin %s", async (origin) => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = controlPlaneTransport();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli([...createArgs], {
      credentialPath,
      fetch: transport.fetch,
      env: { CONTROL_PLANE_API_ORIGIN: origin },
    });

    expect(code).not.toBe(EXIT_OK);
    expect(transport.requests).toHaveLength(0);
  });

  it("allows local loopback ports and rejects a non-loopback host", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const allowed = controlPlaneTransport();
    expect(
      await runCli([...createArgs], {
        credentialPath,
        fetch: allowed.fetch,
        env: {
          SPLITCH_PLATFORM_TARGET: "local",
          CONTROL_PLANE_API_ORIGIN: "http://127.0.0.1:9999",
        },
      }),
    ).toBe(EXIT_OK);
    expect(
      allowed.requests.some((request) => request.url.startsWith("http://127.0.0.1:9999/")),
    ).toBe(true);

    const rejected = controlPlaneTransport();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await runCli([...createArgs], {
        credentialPath,
        fetch: rejected.fetch,
        env: {
          SPLITCH_PLATFORM_TARGET: "local",
          CONTROL_PLANE_API_ORIGIN: "http://attacker.invalid:9999",
        },
      }),
    ).not.toBe(EXIT_OK);
    expect(rejected.requests).toHaveLength(0);
  });
});
