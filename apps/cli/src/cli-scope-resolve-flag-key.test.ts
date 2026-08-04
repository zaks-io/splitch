import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK, EXIT_SCOPE } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
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
      ...scopeResolutionStubs({ flags: checkoutBannerFlags }),
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
      ...scopeResolutionStubs({ flags: checkoutBannerFlags }),
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
      ...scopeResolutionStubs({
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
    // Must not treat the key as a path-segment ID.
    expect(
      transport.requests.some(
        (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/app_1/flags/flag_beta",
      ),
    ).toBe(false);
  });
});

describe("flags get unresolved selectors", () => {
  it("fails with CLI_SCOPE_UNRESOLVED naming the unknown key and App", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs({ flags: checkoutBannerFlags }),
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

  it("fails loud when the catalog is truncated and the key is not on the page", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs({
        flags: [{ id: "flag_other", key: "other-flag" }],
        flagsReadTruncated: true,
        flagsReadLimit: 200,
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
      ...scopeResolutionStubs({ flags: checkoutBannerFlags }),
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

describe("body-only flagId is not resolved", () => {
  it("leaves experiments create --body-json flagId alone (no :flagId route param)", async () => {
    const { credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      // No flags catalog stub: body-only flagId must not trigger Flag resolution.
      ...scopeResolutionStubs(),
      {
        match: (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname === "/apps/app_1/envs/env_1/experiments",
        status: 200,
        body: {
          id: "exp_1",
          appId: "app_1",
          environmentId: "env_1",
          key: "checkout-exp",
          flagId: "checkout-banner",
          name: "Checkout exp",
          status: "draft",
          targetingKey: "userId",
          targetingKeyType: "user",
          confidenceLevel: 0.95,
          defaultVariantId: "var_on",
          metrics: [],
          guardrailMetrics: [],
          dimensions: [],
          conversionWindowMs: 0,
          liveRunId: null,
          createdAt: "2026-07-03T00:00:00.000Z",
          updatedAt: "2026-07-03T00:00:00.000Z",
        },
      },
    ]);

    const code = await runCli(
      [
        "experiments",
        "create",
        "--json",
        "--app",
        "app_1",
        "--env",
        "env_1",
        "--body-json",
        JSON.stringify({
          key: "checkout-exp",
          name: "Checkout exp",
          flagId: "checkout-banner",
          targetingKey: "userId",
          targetingKeyType: "user",
          metrics: [],
        }),
      ],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_OK);
    expect(
      transport.requests.some(
        (request) =>
          request.method === "GET" && new URL(request.url).pathname === "/apps/app_1/flags",
      ),
    ).toBe(false);
    const create = transport.requests.find(
      (request) =>
        request.method === "POST" &&
        new URL(request.url).pathname === "/apps/app_1/envs/env_1/experiments",
    );
    expect(create?.body).toMatchObject({ flagId: "checkout-banner" });
  });
});
