import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_API, EXIT_OK, EXIT_SELECTOR_AMBIGUOUS } from "./exit-codes.js";
import { flagsListStub, scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, jsonError, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

describe("Environment selector collisions", () => {
  it("renders the server's ambiguity refusal", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs({
        environments: [
          { id: "env_collision", key: "production", name: "Production" },
          { id: "env_other", key: "env_collision", name: "Collision" },
        ],
      }),
      {
        match: (request) => new URL(request.url).pathname === "/apps/app_1/envs/env_collision",
        status: 409,
        body: {
          code: "SELECTOR_AMBIGUOUS",
          message: 'Environment selector "env_collision" matches more than one Environment',
          details: {
            recommendedAction: "USE_CANONICAL_ID",
            candidates: [
              { environmentId: "env_collision", environmentKey: "production" },
              { environmentId: "env_other", environmentKey: "env_collision" },
            ],
          },
        },
      },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(
      ["env-policy", "get", "--json", "--app", "app_1", "--env", "env_collision"],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_SELECTOR_AMBIGUOUS);
    expect(error.mock.calls.join(" ")).toContain("Environment production");
    expect(error.mock.calls.join(" ")).toContain("--env env_other");
    expect(
      transport.requests.some(
        (request) => new URL(request.url).pathname === "/apps/app_1/envs/env_collision",
      ),
    ).toBe(true);
  });
});

describe("truncated org/app/env catalogs", () => {
  it("lets the server refuse a missing App selector", async () => {
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
    expect(error.mock.calls.join(" ")).toContain("APP_NOT_FOUND");
    expect(
      transport.requests.some((request) => new URL(request.url).pathname.includes("/missing-app/")),
    ).toBe(true);
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
