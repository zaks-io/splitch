import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_API, EXIT_OK, EXIT_SELECTOR_AMBIGUOUS } from "./exit-codes.js";
import {
  FakeCliTransport,
  flagConfigResponse,
  flagListPage,
  flagRecord,
  storedCredential,
} from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

async function selectorBoundCredential(appSelector = "checkout") {
  const home = await makeTempHome();
  await writeFile(
    home.credentialPath,
    `${JSON.stringify({
      ...storedCredential(),
      credential: {
        ...storedCredential().credential,
        accessTokenBinding: `app:${appSelector}`,
      },
    })}\n`,
  );
  return home;
}

function controlPlaneRequests(transport: FakeCliTransport) {
  return transport.requests.filter((request) => new URL(request.url).pathname.startsWith("/apps/"));
}

const hydratedFlagRecord = { ...flagRecord, configurations: [] };
const hydratedFlagListPage = { ...flagListPage, items: [hydratedFlagRecord] };

describe("server-side selector resolution", () => {
  it("sends an App selector verbatim and lists Flags in exactly one control-plane request", async () => {
    const { credentialPath } = await selectorBoundCredential();
    const transport = new FakeCliTransport([
      {
        match: (request) => {
          const url = new URL(request.url);
          return url.pathname === "/apps/checkout/flags" && url.search === "?include=config";
        },
        status: 200,
        body: hydratedFlagListPage,
      },
    ]);

    const code = await runCli(["flags", "list", "--json", "--app", "checkout"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(controlPlaneRequests(transport)).toHaveLength(1);
    expect(new URL(controlPlaneRequests(transport)[0]?.url ?? "").pathname).toBe(
      "/apps/checkout/flags",
    );
  });

  it("sends App and Flag selectors verbatim in exactly one control-plane request", async () => {
    const { credentialPath } = await selectorBoundCredential();
    const transport = new FakeCliTransport([
      {
        match: (request) => {
          const url = new URL(request.url);
          return (
            url.pathname === "/apps/checkout/flags/checkout-banner" &&
            url.search === "?include=config"
          );
        },
        status: 200,
        body: { ...hydratedFlagRecord, key: "checkout-banner" },
      },
    ]);

    const code = await runCli(["flags", "get", "--json", "--app", "checkout", "checkout-banner"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(controlPlaneRequests(transport)).toHaveLength(1);
    expect(new URL(controlPlaneRequests(transport)[0]?.url ?? "").pathname).toBe(
      "/apps/checkout/flags/checkout-banner",
    );
  });

  it("keeps key-addressed read-modify-write paths verbatim", async () => {
    const { credentialPath } = await selectorBoundCredential();
    const transport = new FakeCliTransport([
      {
        match: (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/checkout/flags/checkout-banner",
        status: 200,
        body: { ...flagRecord, id: "flag_checkout", key: "checkout-banner" },
      },
      {
        match: (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === "/apps/checkout/envs/prod/flags/checkout-banner/config",
        status: 200,
        body: { ...flagConfigResponse, flagId: "flag_checkout", environmentId: "env_prod" },
      },
      {
        match: (request) =>
          request.method === "PUT" &&
          new URL(request.url).pathname ===
            "/apps/checkout/envs/prod/flags/checkout-banner/targeting-rules",
        status: 200,
        body: {
          ...flagConfigResponse,
          flagId: "flag_checkout",
          environmentId: "env_prod",
          approvalRequest: null,
        },
      },
    ]);

    const code = await runCli(
      [
        "flag-targeting-rules",
        "add",
        "checkout-banner",
        "--app",
        "checkout",
        "--env",
        "prod",
        "--when",
        "plan=enterprise",
        "--serve",
        "on",
      ],
      { credentialPath, fetch: transport.fetch },
    );

    expect(code).toBe(EXIT_OK);
    expect(controlPlaneRequests(transport).map((request) => new URL(request.url).pathname)).toEqual(
      [
        "/apps/checkout/flags/checkout-banner",
        "/apps/checkout/envs/prod/flags/checkout-banner/config",
        "/apps/checkout/envs/prod/flags/checkout-banner/targeting-rules",
      ],
    );
    expect(controlPlaneRequests(transport)[2]?.body).toMatchObject({
      targetingRules: [expect.objectContaining({ flagId: "flag_checkout" })],
    });
  });

  it("prints ambiguous App candidates and exact retry commands with a distinct exit code", async () => {
    const { credentialPath } = await selectorBoundCredential();
    const ambiguous = {
      code: "SELECTOR_AMBIGUOUS" as const,
      message: 'App selector "checkout" matches more than one App',
      details: {
        recommendedAction: "USE_CANONICAL_ID" as const,
        candidates: [
          { orgSlug: "acme", appId: "app_acme", appSlug: "checkout" },
          { orgSlug: "labs", appId: "app_labs", appSlug: "checkout" },
        ],
      },
    };
    const transport = new FakeCliTransport([
      {
        match: (request) => new URL(request.url).pathname === "/apps/checkout/flags",
        status: 409,
        body: ambiguous,
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["flags", "list", "--json", "--app", "checkout"], {
      credentialPath,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_SELECTOR_AMBIGUOUS);
    expect(code).not.toBe(EXIT_API);
    expect(JSON.parse(log.mock.calls.join(""))).toMatchObject({
      code: "SELECTOR_AMBIGUOUS",
      details: ambiguous.details,
      remediation: expect.stringContaining("splitch flags list --json --app app_acme"),
    });
    const stderr = error.mock.calls.join(" ");
    expect(stderr).toContain("App checkout in Organization acme");
    expect(stderr).toContain("splitch flags list --json --app app_acme");
    expect(stderr).toContain("App checkout in Organization labs");
    expect(stderr).toContain("splitch flags list --json --app app_labs");
  });
});
