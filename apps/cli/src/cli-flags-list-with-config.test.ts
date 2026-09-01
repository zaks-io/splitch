import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_API, EXIT_OK } from "./exit-codes.js";
import { FakeCliTransport, flagListPage, flagRecord, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

const hydratedFlag = {
  ...flagRecord,
  configurations: [
    {
      environmentId: "env_dev",
      enabled: true,
      availableVariantNames: ["on"],
      targetingRules: [],
      rollout: { percentage: 25, salt: "dev-salt" },
      experiment: null,
    },
    {
      environmentId: "env_prod",
      enabled: false,
      availableVariantNames: ["on"],
      targetingRules: [
        {
          id: "rule_enterprise",
          flagId: flagRecord.id,
          priority: 0,
          conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
          variantId: "var_on",
        },
      ],
      rollout: null,
      experiment: { id: "exp_checkout", key: "checkout-copy" },
    },
  ],
};

const hydratedPage = { ...flagListPage, items: [hydratedFlag] };

async function credentialPath(): Promise<string> {
  const home = await makeTempHome();
  await writeFile(home.credentialPath, `${JSON.stringify(storedCredential())}\n`);
  return home.credentialPath;
}

async function selectedScope() {
  const home = await makeTempHome();
  await writeFile(home.credentialPath, `${JSON.stringify(storedCredential())}\n`);
  await writeFile(
    join(home.dir, "splitch.json"),
    `${JSON.stringify({ version: 1, app: "app_1", environment: "env_dev" })}\n`,
  );
  return home;
}

describe("hydrated Flag reads", () => {
  it("renders every Configuration and the running Experiment from one flags get request", async () => {
    const credentials = await credentialPath();
    const transport = new FakeCliTransport([
      {
        match: (request) => {
          const url = new URL(request.url);
          return url.pathname === "/apps/app_1/flags/checkout" && url.search === "?include=config";
        },
        status: 200,
        body: hydratedFlag,
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["flags", "get", "--app", "app_1", "checkout"], {
      credentialPath: credentials,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(log.mock.calls.join("\n")).toMatchInlineSnapshot(`
      "Flag: Checkout
      ID: flag_checkout
      App: app_local
      Key: checkout
      Schema: (none)
      Default Variant ID: var_on
      Created: 2026-07-03T00:00:00.000Z
      Updated: 2026-07-03T00:00:00.000Z

      Variants
      VARIANT ID  NAME  VALUE  DESCRIPTION
      var_on      on    true

      Configurations
      Environment: env_dev
      Enabled: true
      Available Variants: on
      Rollout: 25% (salt dev-salt)
      Experiment: (none)
      Targeting Rules: (none)

      Environment: env_prod
      Enabled: false
      Available Variants: on
      Rollout: (none)
      Experiment: checkout-copy (exp_checkout)
      Targeting Rules
      RULE ID          PRIORITY  CONDITIONS                                                   VARIANT ID  SEGMENT ID  ROLLOUT
      rule_enterprise  0         [{"attribute":"plan","operator":"eq","value":"enterprise"}]  var_on"
    `);
    expect(transport.requests.filter((request) => request.url.includes("/flags/"))).toHaveLength(1);
  });

  it("writes the complete hydrated list envelope unchanged under --json", async () => {
    const credentials = await credentialPath();
    const transport = new FakeCliTransport([
      {
        match: (request) => new URL(request.url).search === "?include=config",
        status: 200,
        body: hydratedPage,
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["flags", "list", "--app", "app_1", "--json"], {
      credentialPath: credentials,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual(hydratedPage);
    expect(transport.requests.filter((request) => request.url.includes("/flags"))).toHaveLength(1);
  });

  it("omits envs when --env is absent, even when active config selects an Environment", async () => {
    const scope = await selectedScope();
    const transport = new FakeCliTransport([
      {
        match: (request) => {
          const url = new URL(request.url);
          return url.searchParams.get("include") === "config" && !url.searchParams.has("envs");
        },
        status: 200,
        body: hydratedPage,
      },
    ]);

    const code = await runCli(["flags", "list", "--json"], {
      ...scope,
      cwd: scope.dir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(transport.requests.filter((request) => request.url.includes("/flags"))).toHaveLength(1);
  });

  it("sends an explicit --env verbatim through envs on the hydrated request", async () => {
    const credentials = await credentialPath();
    const transport = new FakeCliTransport([
      {
        match: (request) => {
          const url = new URL(request.url);
          return url.pathname === "/apps/app_1/flags" && url.searchParams.get("envs") === "prod";
        },
        status: 200,
        body: {
          ...hydratedPage,
          items: [{ ...hydratedFlag, configurations: [hydratedFlag.configurations[1]] }],
        },
      },
    ]);

    const code = await runCli(["flags", "list", "--app", "app_1", "--env", "prod", "--json"], {
      credentialPath: credentials,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(transport.requests.filter((request) => request.url.includes("/flags"))).toHaveLength(1);
  });

  it("fails loudly when a hydrated response omits Configurations", async () => {
    const credentials = await credentialPath();
    const transport = new FakeCliTransport([
      { match: (request) => request.url.includes("/flags"), status: 200, body: flagListPage },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["flags", "list", "--app", "app_1"], {
      credentialPath: credentials,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_API);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("server returned an unhydrated response"),
    );
  });
});

describe("flags list --summary", () => {
  it("returns the curated server-contract error for a malformed summary envelope", async () => {
    const credentials = await credentialPath();
    const transport = new FakeCliTransport([
      {
        match: (request) => !new URL(request.url).searchParams.has("include"),
        status: 200,
        body: hydratedPage,
      },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["flags", "list", "--app", "app_1", "--summary"], {
      credentialPath: credentials,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_API);
    expect(error.mock.calls.join(" ")).toContain("INTERNAL_SERVER_ERROR");
    expect(error.mock.calls.join(" ")).toContain("compact Flag summary");
    expect(error.mock.calls.join(" ")).not.toContain("invalid_type");
  });

  it("uses the compact list-table pattern without requesting hydration", async () => {
    const credentials = await credentialPath();
    const transport = new FakeCliTransport([
      {
        match: (request) => !new URL(request.url).searchParams.has("include"),
        status: 200,
        body: flagListPage,
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["flags", "list", "--app", "app_1", "--summary"], {
      credentialPath: credentials,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(log.mock.calls.join("\n")).toMatchInlineSnapshot(`
      "ID             KEY       NAME
      flag_checkout  checkout  Checkout"
    `);
    expect(transport.requests.filter((request) => request.url.includes("/flags"))).toHaveLength(1);
  });
});

describe("bounded Flag catalog in human output", () => {
  it.each([
    { args: ["flags", "list", "--app", "app_1"], page: hydratedPage, label: "hydrated" },
    {
      args: ["flags", "list", "--app", "app_1", "--summary"],
      page: flagListPage,
      label: "summary",
    },
  ])("says the catalog was truncated in $label output", async ({ args, page }) => {
    const credentials = await credentialPath();
    const transport = new FakeCliTransport([
      {
        match: (request) => new URL(request.url).pathname === "/apps/app_1/flags",
        status: 200,
        body: { ...page, readTruncated: true },
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(args, { credentialPath: credentials, fetch: transport.fetch });

    expect(code).toBe(EXIT_OK);
    expect(log.mock.calls.join("\n")).toContain(
      "Truncated: more than 200 Flags exist; 200 are shown.",
    );
  });

  it("stays silent about truncation when the catalog is complete", async () => {
    const credentials = await credentialPath();
    const transport = new FakeCliTransport([
      {
        match: (request) => new URL(request.url).pathname === "/apps/app_1/flags",
        status: 200,
        body: hydratedPage,
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["flags", "list", "--app", "app_1"], {
      credentialPath: credentials,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(log.mock.calls.join("\n")).not.toContain("Truncated");
  });

  it("names an empty catalog instead of printing a blank line", async () => {
    const credentials = await credentialPath();
    const transport = new FakeCliTransport([
      {
        match: (request) => new URL(request.url).pathname === "/apps/app_1/flags",
        status: 200,
        body: { ...hydratedPage, items: [] },
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["flags", "list", "--app", "app_1"], {
      credentialPath: credentials,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(log.mock.calls.join("\n")).toBe("No Flags found.");
  });
});
