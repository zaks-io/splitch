import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK } from "./exit-codes.js";
import { authHeader, flagRecord, FakeCliTransport, storedCredential } from "./test-fixtures.js";
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
    expect(transport.requests[0]?.url.startsWith("https://api.splitch.dev/")).toBe(true);
    expect(transport.requests[0]?.authorization).toBe(authHeader());
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
    expect(transport.requests[0]?.url.startsWith("http://127.0.0.1:8787/")).toBe(true);
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
    expect(transport.requests[0]?.url.startsWith("https://env.example/")).toBe(true);
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
    expect(transport.requests[0]?.url.startsWith("https://option.example/")).toBe(true);
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
