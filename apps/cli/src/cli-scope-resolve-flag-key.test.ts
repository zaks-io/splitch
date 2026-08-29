import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK } from "./exit-codes.js";
import { FakeCliTransport, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

const hydratedFlag = {
  id: "flag_checkout_banner",
  appId: "app_1",
  key: "checkout-banner",
  name: "Checkout banner",
  schema: null,
  variants: [{ id: "var_on", name: "on", value: true }],
  defaultVariantId: "var_on",
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
  configurations: [
    {
      environmentId: "env_1",
      enabled: true,
      availableVariantNames: ["on"],
      targetingRules: [],
      rollout: null,
      experiment: null,
    },
  ],
};

describe("flags get server-side key-or-id resolution", () => {
  it("sends a Flag key directly in one hydrated request", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      {
        match: (request) => {
          const url = new URL(request.url);
          return (
            url.pathname === "/apps/app_1/flags/checkout-banner" &&
            url.searchParams.get("include") === "config"
          );
        },
        status: 200,
        body: hydratedFlag,
      },
    ]);

    const code = await runCli(["flags", "get", "--json", "--app", "app_1", "checkout-banner"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(transport.requests).toHaveLength(1);
  });

  it("sends a canonical Flag ID directly in one hydrated request", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      {
        match: (request) =>
          new URL(request.url).pathname === "/apps/app_1/flags/flag_checkout_banner",
        status: 200,
        body: hydratedFlag,
      },
    ]);

    const code = await runCli(
      ["flags", "get", "--json", "--app", "app_1", "flag_checkout_banner"],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_OK);
    expect(transport.requests).toHaveLength(1);
  });

  it("forwards --by key for a canonical-looking key without a catalog lookup", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      {
        match: (request) => {
          const url = new URL(request.url);
          return (
            url.pathname === "/apps/app_1/flags/flag_beta" && url.searchParams.get("by") === "key"
          );
        },
        status: 200,
        body: { ...hydratedFlag, id: "flag_real_01", key: "flag_beta", name: "Flag beta" },
      },
    ]);

    const code = await runCli(
      ["flags", "get", "--json", "--app", "app_1", "--by", "key", "flag_beta"],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_OK);
    expect(transport.requests).toHaveLength(1);
  });
});
