import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK, EXIT_SELECTOR_AMBIGUOUS } from "./exit-codes.js";
import { FakeCliTransport, oauthTokenMint, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempHomes();
});

const STAMPS = {
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
};

const USE_APPS = [
  { id: "app_cfg", organizationId: "org_1", key: "checkout", name: "Checkout", ...STAMPS },
  { id: "app_other", organizationId: "org_1", key: "billing", name: "Billing", ...STAMPS },
];

function useSelectionTransport(): FakeCliTransport {
  return new FakeCliTransport([
    oauthTokenMint(),
    {
      match: (request) => new URL(request.url).pathname === "/apps/app_cfg",
      status: 200,
      body: USE_APPS[0],
    },
    {
      match: (request) => new URL(request.url).pathname === "/apps/app_other",
      status: 200,
      body: USE_APPS[1],
    },
  ]);
}

async function useProject(app: string, environment: string) {
  const home = await makeTempHome();
  await writeFile(home.credentialPath, `${JSON.stringify(storedCredential())}\n`);
  const configDir = join(home.dir, "project");
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, "splitch.json");
  await writeFile(configPath, `${JSON.stringify({ version: 1, app, environment })}\n`);
  return { credentialPath: home.credentialPath, configDir, configPath };
}

/**
 * `splitch use` validates through apps_get and persists only the canonical ID
 * returned by the server. These tests pin the server-owned ID-first and
 * ambiguity outcomes without recreating either rule in the CLI.
 */
describe("splitch use delegates App selector resolution", () => {
  function twoOrgTransport(secondOrgApps: readonly unknown[]): FakeCliTransport {
    const ambiguous = secondOrgApps.some(
      (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        "key" in candidate &&
        candidate.key === "checkout",
    );
    return new FakeCliTransport([
      oauthTokenMint(),
      {
        match: (request) =>
          new URL(request.url).pathname ===
          (ambiguous ? "/apps/checkout" : "/apps/app_victimtarget"),
        status: ambiguous ? 409 : 200,
        body: ambiguous
          ? {
              code: "SELECTOR_AMBIGUOUS",
              message: 'App selector "checkout" matches more than one App',
              details: {
                recommendedAction: "USE_CANONICAL_ID",
                candidates: [
                  { orgSlug: "attacker", appId: "app_attackerdupe", appSlug: "checkout" },
                  { orgSlug: "victim", appId: "app_victimtarget", appSlug: "checkout" },
                ],
              },
            }
          : {
              id: "app_victimtarget",
              organizationId: "org_victim",
              key: "checkout",
              name: "Checkout",
              ...STAMPS,
            },
      },
    ]);
  }

  it("uses the server's canonical App when an earlier Organization has a colliding key", async () => {
    const { credentialPath, configDir, configPath } = await useProject("app_cfg", "env_dev");
    const transport = twoOrgTransport([
      {
        id: "app_attackerbait",
        organizationId: "org_attacker",
        key: "app_victimtarget",
        name: "Bait",
        ...STAMPS,
      },
    ]);

    const code = await runCli(["use", "--app", "app_victimtarget", "--json"], {
      credentialPath,
      cwd: configDir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(await readFile(configPath, "utf8")).app).toBe("app_victimtarget");
  });

  it("refuses a key that matches an App in more than one Organization", async () => {
    const { credentialPath, configDir, configPath } = await useProject("app_cfg", "env_dev");
    const transport = twoOrgTransport([
      {
        id: "app_attackerdupe",
        organizationId: "org_attacker",
        key: "checkout",
        name: "Checkout",
        ...STAMPS,
      },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["use", "--app", "checkout", "--json"], {
      credentialPath,
      cwd: configDir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_SELECTOR_AMBIGUOUS);
    expect(error.mock.calls.join(" ")).toContain("--app app_attackerdupe");
    expect(error.mock.calls.join(" ")).toContain("--app app_victimtarget");
    expect(JSON.parse(await readFile(configPath, "utf8")).app).toBe("app_cfg");
  });
});

describe("splitch use Environment retention", () => {
  it("keeps the Environment when the selected App is the one already in config", async () => {
    const { credentialPath, configDir, configPath } = await useProject("app_cfg", "env_dev");
    const transport = useSelectionTransport();

    const code = await runCli(["use", "--app", "app_cfg", "--json"], {
      credentialPath,
      cwd: configDir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(await readFile(configPath, "utf8")).environment).toBe("env_dev");
  });

  it("clears and reports the Environment when the App actually changes", async () => {
    const { credentialPath, configDir, configPath } = await useProject("app_cfg", "env_dev");
    const transport = useSelectionTransport();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["use", "--app", "app_other", "--json"], {
      credentialPath,
      cwd: configDir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(await readFile(configPath, "utf8")).environment).toBeUndefined();
    expect(JSON.parse(log.mock.calls.join("")).clearedEnvironmentId).toBe("env_dev");
  });
});
