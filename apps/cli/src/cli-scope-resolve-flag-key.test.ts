import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
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

describe("flags get server-side key-or-id resolution", () => {
  it("forwards a Flag key unchanged", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/app_1/flags/checkout-banner",
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
          new URL(request.url).pathname === "/apps/app_1/flags/checkout-banner",
      ),
    ).toBe(true);
    expect(
      transport.requests.filter((request) => new URL(request.url).pathname.startsWith("/apps/")),
    ).toHaveLength(1);
  });

  it("forwards a canonical Flag ID without a catalog read", async () => {
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
    expect(transport.requests).toHaveLength(1);
    expect(
      transport.requests.some(
        (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/app_1/flags/flag_checkout_banner",
      ),
    ).toBe(true);
  });

  it("forwards by=key for a canonical-looking Flag key", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) => {
          const url = new URL(request.url);
          return (
            request.method === "GET" &&
            url.pathname === "/apps/app_1/flags/flag_beta" &&
            url.searchParams.get("by") === "key"
          );
        },
        status: 200,
        body: {
          ...flagGetBody,
          id: "flag_real_01",
          key: "flag_beta",
          name: "Flag beta",
        },
      },
    ]);

    const code = await runCli(
      ["flags", "get", "--json", "--app", "app_1", "--by", "key", "flag_beta"],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_OK);
    expect(
      transport.requests.some(
        (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/app_1/flags/flag_beta" &&
          new URL(request.url).searchParams.get("by") === "key",
      ),
    ).toBe(true);
  });

  it("lets the server select a colliding key explicitly", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs(),
      {
        match: (request) => {
          const url = new URL(request.url);
          return (
            url.pathname === "/apps/app_1/flags/flag_shared" && url.searchParams.get("by") === "key"
          );
        },
        status: 200,
        body: { ...flagGetBody, id: "flag_other", key: "flag_shared", name: "Key collision" },
      },
    ]);

    const code = await runCli(
      ["flags", "get", "--json", "--app", "app_1", "--by", "key", "flag_shared"],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_OK);
    expect(transport.requests).toHaveLength(1);
  });
});
