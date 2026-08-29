import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_API } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, jsonError, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

describe("flags get unresolved selectors", () => {
  it("lets the server return FLAG_NOT_FOUND for a missing key", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/app_1/flags/missing-banner",
        status: 404,
        body: jsonError("FLAG_NOT_FOUND", "flag not found"),
      },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["flags", "get", "--json", "--app", "app_1", "missing-banner"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_API);
    const message = error.mock.calls.join(" ");
    expect(message).toContain("FLAG_NOT_FOUND");
    expect(message).not.toContain("CLI_SCOPE_UNRESOLVED");
    expect(
      transport.requests.some((request) =>
        new URL(request.url).pathname.includes("/flags/missing-banner"),
      ),
    ).toBe(true);
  });

  it("passes an id-shaped selector verbatim when the catalog is truncated", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/app_1/flags/flag_past_ceiling",
        status: 404,
        body: jsonError("FLAG_NOT_FOUND", "flag not found"),
      },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["flags", "get", "--json", "--app", "app_1", "flag_past_ceiling"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_API);
    expect(
      transport.requests.some(
        (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/app_1/flags/flag_past_ceiling",
      ),
    ).toBe(true);
    const message = error.mock.calls.join(" ");
    expect(message).toContain("FLAG_NOT_FOUND");
    expect(message).not.toContain("CLI_SCOPE_UNRESOLVED");
  });

  it("passes a key-shaped selector verbatim when the catalog is truncated", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/app_1/flags/checkout-banner",
        status: 404,
        body: jsonError("FLAG_NOT_FOUND", "flag not found"),
      },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["flags", "get", "--json", "--app", "app_1", "checkout-banner"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_API);
    expect(
      transport.requests.some(
        (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/app_1/flags/checkout-banner",
      ),
    ).toBe(true);
    const message = error.mock.calls.join(" ");
    expect(message).toContain("FLAG_NOT_FOUND");
    expect(message).not.toContain("CLI_SCOPE_UNRESOLVED");
  });
});
