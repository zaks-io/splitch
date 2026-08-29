import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import {
  FakeCliTransport,
  flagListPage,
  oauthTokenMint,
  storedCredential,
} from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

const configuredPage = {
  ...flagListPage,
  items: [
    {
      ...flagListPage.items[0],
      flagConfiguration: configuredFlag(true, 25),
    },
    {
      ...flagListPage.items[0],
      id: "flag_search",
      key: "search",
      name: "Search",
      flagConfiguration: configuredFlag(false, null),
    },
  ],
};

function configuredFlag(enabled: boolean, rollout: number | null) {
  return {
    enabled,
    rollout,
    defaultVariant: "on",
    availableVariantNames: ["on"],
    targetingRuleRolloutPercentages: rollout === null ? [] : [rollout],
    experiment: null,
  };
}

async function selectedScope(environmentId = "env_dev") {
  const { dir, credentialPath } = await makeTempHome();
  await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
  await mkdir(join(dir, ".splitch"), { recursive: true });
  await writeFile(
    join(dir, ".splitch", "config.json"),
    `${JSON.stringify({ version: 1, app: "app_1", environment: environmentId })}\n`,
  );
  return { dir, credentialPath };
}

describe("flags list --with-config", () => {
  it("uses the selected Environment and writes the enriched machine-readable shape", async () => {
    const scope = await selectedScope();
    const transport = new FakeCliTransport([
      oauthTokenMint(),
      {
        match: (request) =>
          new URL(request.url).pathname === "/apps/app_1/flags" &&
          new URL(request.url).searchParams.get("environmentId") === "env_dev",
        status: 200,
        body: configuredPage,
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["flags", "list", "--with-config", "--json"], {
      ...scope,
      cwd: scope.dir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(log.mock.calls.join(""))).toEqual(configuredPage);
    expect(transport.requests.filter((request) => request.url.includes("/flags"))).toHaveLength(1);
  });

  it("renders both Flags for humans and honors an --env override", async () => {
    const scope = await selectedScope("env_dev");
    const transport = new FakeCliTransport([
      ...scopeResolutionStubs({ appId: "app_1" }),
      {
        match: (request) =>
          new URL(request.url).pathname === "/apps/app_1/flags" &&
          new URL(request.url).searchParams.get("environmentId") === "prod",
        status: 200,
        body: configuredPage,
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["flags", "list", "--with-config", "--env", "prod"], {
      ...scope,
      cwd: scope.dir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    const human = log.mock.calls.join("\n");
    expect(human).toContain('"key": "checkout"');
    expect(human).toContain('"key": "search"');
    expect(human).toContain('"enabled": true');
    expect(human).toContain('"rollout": 25');
    expect(human).toContain('"defaultVariant": "on"');
  });

  it("keeps bare flags list JSON unchanged even when an Environment is selected", async () => {
    const scope = await selectedScope();
    const transport = new FakeCliTransport([
      oauthTokenMint(),
      {
        match: (request) =>
          new URL(request.url).pathname === "/apps/app_1/flags" &&
          !new URL(request.url).searchParams.has("environmentId"),
        status: 200,
        body: flagListPage,
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["flags", "list", "--json"], {
      ...scope,
      cwd: scope.dir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(log.mock.calls.join(""))).toEqual(flagListPage);
  });
});
