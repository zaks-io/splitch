import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK, EXIT_SCOPE } from "./exit-codes.js";
import { flagKeyResolutionStub, scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, flagConfigResponse, storedCredential } from "./test-fixtures.js";
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

describe("flags get key-or-id resolution", () => {
  it("accepts a Flag key and calls the API with the canonical ID", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagKeyResolutionStub(),
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

  it("accepts a canonical Flag ID without listing the catalog", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
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
    ).toBe(false);
  });

  it("fails with CLI_SCOPE_UNRESOLVED naming the unknown key and App", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([...scopeResolutionStubs(), flagKeyResolutionStub()]);
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

  it("fails loud when the catalog is truncated and the key is not on the page", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagKeyResolutionStub({
        flags: [{ id: "flag_other", key: "other-flag" }],
        readTruncated: true,
        readLimit: 200,
      }),
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["flags", "get", "--json", "--app", "app_1", "checkout-banner"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_SCOPE);
    const message = error.mock.calls.join(" ");
    expect(message).toContain("CLI_SCOPE_UNRESOLVED");
    expect(message).toContain("checkout-banner");
    expect(message).toContain("read ceiling");
    expect(message).not.toContain("FLAG_NOT_FOUND");
  });
});

describe("flag-config get key-or-id resolution", () => {
  it("resolves a Flag key before the config GET", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      flagKeyResolutionStub(),
      {
        match: (request) =>
          request.method === "GET" &&
          request.url.includes("/apps/app_1/envs/env_prod/flags/flag_checkout_banner/config"),
        status: 200,
        body: { ...flagConfigResponse, flagId: "flag_checkout_banner" },
      },
    ]);

    const code = await runCli(
      ["flag-config", "get", "--json", "--app", "app_1", "--env", "env_prod", "checkout-banner"],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_OK);
    expect(
      transport.requests.some((request) =>
        request.url.includes("/apps/app_1/envs/env_prod/flags/flag_checkout_banner/config"),
      ),
    ).toBe(true);
  });
});
