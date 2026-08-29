import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK, EXIT_SCOPE } from "./exit-codes.js";
import { flagsListStub, scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, jsonError, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

describe("Environment selector collisions", () => {
  it("refuses an Environment selector shared by an ID and another Environment key", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs({
        environments: [
          { id: "env_collision", key: "production", name: "Production" },
          { id: "env_other", key: "env_collision", name: "Collision" },
        ],
      }),
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(
      ["env-policy", "get", "--json", "--app", "app_1", "--env", "env_collision"],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_SCOPE);
    expect(error.mock.calls.join(" ")).toContain(
      'Environment selector "env_collision" matches more than one Environment on App app_1: it is the ID of env_collision and the key of env_other',
    );
    expect(
      transport.requests.some(
        (request) => new URL(request.url).pathname === "/apps/app_1/envs/env_collision",
      ),
    ).toBe(false);
  });
});

describe("truncated org/app/env catalogs", () => {
  it("fails with CLI_SCOPE_UNRESOLVED when the App catalog is complete and the key is missing", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([...scopeResolutionStubs()]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["flags", "list", "--json", "--app", "missing-app"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_SCOPE);
    expect(error.mock.calls.join(" ")).toContain("CLI_SCOPE_UNRESOLVED");
    expect(
      transport.requests.some((request) => new URL(request.url).pathname.includes("/missing-app/")),
    ).toBe(false);
  });

  it("does not resolve a visible App key when the catalog is truncated", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      {
        match: (request) =>
          request.method === "GET" && new URL(request.url).pathname === "/orgs/org_1/apps",
        status: 200,
        body: {
          items: [
            {
              id: "app_visible",
              organizationId: "org_1",
              key: "checkout",
              name: "Visible",
              createdAt: "2026-07-03T00:00:00.000Z",
              updatedAt: "2026-07-03T00:00:00.000Z",
            },
          ],
          readLimit: 200,
          readTruncated: true,
          cursor: null,
        },
      },
      ...scopeResolutionStubs(),
      flagsListStub({ appId: "checkout", flags: [] }),
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["flags", "list", "--json", "--app", "checkout"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(
      transport.requests.some(
        (request) => new URL(request.url).pathname === "/apps/checkout/flags",
      ),
    ).toBe(true);
    expect(
      transport.requests.some(
        (request) => new URL(request.url).pathname === "/apps/app_visible/flags",
      ),
    ).toBe(false);
    expect(error.mock.calls.join(" ")).not.toContain("CLI_SCOPE_UNRESOLVED");
  });

  it("passes a missing App key through when the catalog is truncated", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      {
        match: (request) =>
          request.method === "GET" && new URL(request.url).pathname === "/orgs/org_1/apps",
        status: 200,
        body: { items: [], readLimit: 200, readTruncated: true, cursor: null },
      },
      ...scopeResolutionStubs(),
      flagsListStub({ appId: "missing-app", flags: [] }),
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["flags", "list", "--json", "--app", "missing-app"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(
      transport.requests.some(
        (request) => new URL(request.url).pathname === "/apps/missing-app/flags",
      ),
    ).toBe(true);
    expect(error.mock.calls.join(" ")).not.toContain("CLI_SCOPE_UNRESOLVED");
  });

  it("passes a missing Environment selector through when the catalog is truncated", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      {
        match: (request) =>
          request.method === "GET" && new URL(request.url).pathname === "/apps/app_1/envs",
        status: 200,
        body: { items: [], readLimit: 200, readTruncated: true, cursor: null },
      },
      ...scopeResolutionStubs(),
      {
        match: (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/app_1/envs/env_past_ceiling",
        status: 404,
        body: jsonError("ENVIRONMENT_NOT_FOUND", "environment not found"),
      },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(
      ["env-policy", "get", "--json", "--app", "app_1", "--env", "env_past_ceiling"],
      { credentialPath, fetch: transport.fetch },
    );

    expect(
      transport.requests.some(
        (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/app_1/envs/env_past_ceiling",
      ),
    ).toBe(true);
    expect(error.mock.calls.join(" ")).not.toContain("CLI_SCOPE_UNRESOLVED");
    expect(code).not.toBe(EXIT_OK);
  });
});
