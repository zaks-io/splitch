import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { SCOPE_REMEDY } from "./context.js";
import { EXIT_AUTH, EXIT_OK, EXIT_SCOPE } from "./exit-codes.js";
import { scopeResolutionStubs } from "./scope-resolution-fixtures.js";
import { FakeCliTransport, flagListPage, storedCredential } from "./test-fixtures.js";
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

  it("exits EXIT_SCOPE when splitch use cannot resolve the requested scope", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);

    const code = await runCli(["use", "--env", "dev", "--json"], {
      credentialPath,
      cwd: dir,
    });

    // Documented in README and on splitch.dev/docs/cli: exit 3 is the scope class.
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
      ...scopeResolutionStubs({ appId: "app_flag" }),
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
    expect(JSON.parse(log.mock.calls.join(""))).toEqual({
      code: "CLI_NOT_AUTHENTICATED",
      message: expect.stringContaining("session"),
      remediation: expect.stringContaining("splitch login"),
      docsUrl: "https://splitch.dev/docs/error/CLI_NOT_AUTHENTICATED",
      details: null,
    });
  });

  it("reports the principal and the next step when authenticated but unscoped", async () => {
    const { dir, credentialPath } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedCredential())}\n`);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["context", "--json"], { credentialPath, cwd: dir });

    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(log.mock.calls.join("")) as {
      authenticated: boolean;
      principal: { userId: string; email: string };
      appId?: string;
      nextSteps: string[];
    };
    expect(payload.authenticated).toBe(true);
    expect(payload.principal).toEqual({
      userId: storedCredential().principal.userId,
      email: storedCredential().principal.email,
    });
    expect(payload.appId).toBeUndefined();
    expect(payload.nextSteps).toContain("splitch orgs list");
  });
});
