import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK, EXIT_SCOPE } from "./exit-codes.js";
import { flagsListStub, scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

const flagGetBody = {
  id: "flag_checkout_banner",
  appId: "app_1",
  key: "checkout-banner",
  name: "Checkout banner",
  schema: null,
  variants: [{ id: "var_on", name: "on", value: true }],
  defaultVariantId: "var_on",
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
};

const checkoutBannerFlags = [
  {
    id: "flag_checkout_banner",
    key: "checkout-banner",
    name: "Checkout banner",
  },
] as const;

describe("flags get key-or-id resolution", () => {
  it("accepts a Flag key and calls the API with the canonical ID", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsListStub({ flags: checkoutBannerFlags }),
      {
        match: (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/app_1/flags/flag_checkout_banner",
        status: 200,
        body: flagGetBody,
      },
    ]);

    const code = await runCli(["flags", "get", "--json", "--app", "app_1", "checkout-banner"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(
      transport.requests.some(
        (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/app_1/flags/flag_checkout_banner",
      ),
    ).toBe(true);
    expect(
      transport.requests.some(
        (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/app_1/flags/checkout-banner",
      ),
    ).toBe(false);
  });

  it("accepts a canonical Flag ID via ID-then-key list matching", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsListStub({ flags: checkoutBannerFlags }),
      {
        match: (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/app_1/flags/flag_checkout_banner",
        status: 200,
        body: flagGetBody,
      },
    ]);

    const code = await runCli(
      ["flags", "get", "--json", "--app", "app_1", "flag_checkout_banner"],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_OK);
    expect(
      transport.requests.some(
        (request) =>
          request.method === "GET" && new URL(request.url).pathname === "/apps/app_1/flags",
      ),
    ).toBe(true);
    expect(
      transport.requests.some(
        (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/app_1/flags/flag_checkout_banner",
      ),
    ).toBe(true);
  });

  it("resolves a flag_-prefixed key to its canonical ID (no ID-shape fast path)", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsListStub({
        flags: [{ id: "flag_real_01", key: "flag_beta", name: "Flag beta" }],
      }),
      {
        match: (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/app_1/flags/flag_real_01",
        status: 200,
        body: {
          ...flagGetBody,
          id: "flag_real_01",
          key: "flag_beta",
          name: "Flag beta",
        },
      },
    ]);

    const code = await runCli(["flags", "get", "--json", "--app", "app_1", "flag_beta"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(
      transport.requests.some(
        (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/app_1/flags/flag_real_01",
      ),
    ).toBe(true);
    expect(
      transport.requests.some(
        (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/app_1/flags/flag_beta",
      ),
    ).toBe(false);
  });

  it("refuses when ID and key match different Flags", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagsListStub({
        flags: [
          { id: "flag_shared", key: "alpha", name: "Alpha" },
          { id: "flag_other", key: "flag_shared", name: "Key collision" },
        ],
      }),
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["flags", "get", "--json", "--app", "app_1", "flag_shared"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_SCOPE);
    const message = error.mock.calls.join(" ");
    expect(message).toContain("CLI_SCOPE_UNRESOLVED");
    expect(message).toContain("flag_shared");
    expect(message).toContain("flag_other");
    expect(
      transport.requests.some(
        (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname.startsWith("/apps/app_1/flags/"),
      ),
    ).toBe(false);
  });
});
