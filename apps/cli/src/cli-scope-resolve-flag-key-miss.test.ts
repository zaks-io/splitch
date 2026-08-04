import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_API, EXIT_SCOPE } from "./exit-codes.js";
import { flagsListStub, scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, jsonError, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

const checkoutBannerFlags = [
  {
    id: "flag_checkout_banner",
    key: "checkout-banner",
    name: "Checkout banner",
  },
] as const;

describe("flags get unresolved selectors", () => {
  it("fails with CLI_SCOPE_UNRESOLVED when the catalog is complete and the key is missing", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsListStub({ flags: checkoutBannerFlags }),
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["flags", "get", "--json", "--app", "app_1", "missing-banner"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_SCOPE);
    const message = error.mock.calls.join(" ");
    expect(message).toContain("CLI_SCOPE_UNRESOLVED");
    expect(message).toContain("missing-banner");
    expect(message).toContain("app_1");
    expect(message).not.toContain("FLAG_NOT_FOUND");
    expect(
      transport.requests.some((request) =>
        new URL(request.url).pathname.includes("/flags/missing-banner"),
      ),
    ).toBe(false);
  });

  it("passes an id-shaped selector verbatim when the catalog is truncated", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsListStub({
        flags: [{ id: "flag_other", key: "other-flag" }],
        readTruncated: true,
        readLimit: 200,
      }),
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
      flagsListStub({
        flags: [{ id: "flag_other", key: "other-flag" }],
        readTruncated: true,
        readLimit: 200,
      }),
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
