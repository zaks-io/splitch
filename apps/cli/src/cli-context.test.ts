import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { SCOPE_REMEDY } from "./context.js";
import { EXIT_AUTH, EXIT_OK, EXIT_SCOPE } from "./exit-codes.js";
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

describe("context resolution", () => {
  it("fails loud with the splitch use / --app remedy when App scope is unresolved", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const transport = new FakeCliTransport([
      {
        match: (request) => request.url.includes("/apps/app_local/flags"),
        status: 200,
        body: flagListPage,
      },
    ]);

    const code = await runCli(["flags", "list", "--json"], {
      credentialPath,
      cwd: dir,
      fetch: transport.fetch,
    });

    expect(code).toBe(EXIT_SCOPE);
  });

  it("resolves App/Env from flags before env vars and config", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const configDir = join(dir, "project");
    await mkdir(join(configDir, ".splitch"), { recursive: true });
    await writeFile(
      join(configDir, ".splitch", "config.json"),
      '{"version":1,"app":"app_cfg","environment":"env_cfg"}\n',
    );
    const transport = new FakeCliTransport([
      oauthTokenMint(),
      {
        match: (request) => request.url.includes("/apps/app_flag/flags"),
        status: 200,
        body: flagListPage,
      },
    ]);

    const code = await runCli(
      ["flags", "list", "--json", "--app", "app_flag", "--env", "env_flag"],
      {
        credentialPath,
        cwd: configDir,
        env: { SPLITCH_APP: "app_env", SPLITCH_ENV: "env_env" },
        fetch: transport.fetch,
      },
    );

    expect(code).toBe(EXIT_OK);
    expect(transport.requests.some((request) => request.url.includes("/apps/app_flag/flags"))).toBe(
      true,
    );
    expect(SCOPE_REMEDY).toContain("splitch use");
  });
});

/**
 * `splitch context` is the first command a cold agent runs. It used to print
 * `{}` at exit 0 with no session, which reads as a successful resolution.
 */
describe("splitch context reports the session, never an empty success", () => {
  it("fails loud with the login remedy when no session exists", async () => {
    const { dir, credentialPath } = await makeTempHome();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["context", "--json"], { credentialPath, cwd: dir });

    expect(code).toBe(EXIT_AUTH);
    expect(error.mock.calls.join(" ")).toContain("CLI_NOT_AUTHENTICATED");
    expect(error.mock.calls.join(" ")).toContain("splitch login");
    expect(log).not.toHaveBeenCalled();
  });

  it("reports the principal and the next step when authenticated but unscoped", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["context", "--json"], { credentialPath, cwd: dir });

    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(log.mock.calls.join("")) as {
      authenticated: boolean;
      principal: { userId: string };
      appId?: string;
      nextSteps: string[];
    };
    expect(payload.authenticated).toBe(true);
    expect(payload.principal.userId).toBe(storedCredential().principal.userId);
    expect(payload.appId).toBeUndefined();
    expect(payload.nextSteps).toContain("splitch orgs list");
  });
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
      match: (request) => request.url.endsWith("/orgs"),
      status: 200,
      body: { items: [{ id: "org_1", name: "Acme", slug: "acme", plan: "free", ...STAMPS }] },
    },
    {
      match: (request) => request.url.includes("/orgs/org_1/apps"),
      status: 200,
      body: { items: USE_APPS },
    },
  ]);
}

async function useProject(app: string, environment: string) {
  const home = await makeTempHome();
  await writeFile(home.credentialPath, `${JSON.stringify(storedCredential())}\n`);
  const configDir = join(home.dir, "project");
  await mkdir(join(configDir, ".splitch"), { recursive: true });
  const configPath = join(configDir, ".splitch", "config.json");
  await writeFile(configPath, `${JSON.stringify({ version: 1, app, environment })}\n`);
  return { credentialPath: home.credentialPath, configDir, configPath };
}

/**
 * The server resolves App selectors ID-first across every reachable App, then
 * per-Org key with an ambiguity refusal (membership-authority.ts). `splitch use`
 * mirrors that rule, and auth-doors.md says the two must not drift, so the CLI
 * half is pinned here against the same two attacks the server tests cover.
 */
describe("splitch use App selector mirrors the server rule", () => {
  function twoOrgTransport(secondOrgApps: readonly unknown[]): FakeCliTransport {
    return new FakeCliTransport([
      oauthTokenMint(),
      {
        match: (request) => request.url.endsWith("/orgs"),
        status: 200,
        body: {
          items: [
            { id: "org_attacker", name: "Attacker", slug: "attacker", plan: "free", ...STAMPS },
            { id: "org_victim", name: "Victim", slug: "victim", plan: "free", ...STAMPS },
          ],
        },
      },
      {
        match: (request) => request.url.includes("/orgs/org_attacker/apps"),
        status: 200,
        body: { items: secondOrgApps },
      },
      {
        match: (request) => request.url.includes("/orgs/org_victim/apps"),
        status: 200,
        body: {
          items: [
            {
              id: "app_victimtarget",
              organizationId: "org_victim",
              key: "checkout",
              name: "Checkout",
              ...STAMPS,
            },
          ],
        },
      },
    ]);
  }

  it("resolves a canonical App ID even when an earlier Org keys an App with it", async () => {
    const { credentialPath, configDir, configPath } = await useProject("app_cfg", "env_dev");
    // The attacker Org enumerates first and keys its App as the victim's ID.
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

    expect(code).not.toBe(EXIT_OK);
    expect(error.mock.calls.join(" ")).toContain("canonical App ID");
    // A refused selection must not have written a guess to the config.
    expect(JSON.parse(await readFile(configPath, "utf8")).app).toBe("app_cfg");
    error.mockRestore();
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
    // Re-selecting the same App is not a switch: an agent re-running the
    // documented `splitch use --app <app>` must not lose its Environment.
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
    // JSON mode gets no stderr notice, so the drop has to be in the payload or
    // it is a silent state change the caller only discovers by later failing.
    expect(JSON.parse(log.mock.calls.join("")).clearedEnvironmentId).toBe("env_dev");
    log.mockRestore();
  });
});
