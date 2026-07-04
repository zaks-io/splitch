import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { SCOPE_REMEDY } from "./context.js";
import { EXIT_OK, EXIT_SCOPE } from "./exit-codes.js";
import { flagListPage, FakeCliTransport, storedCredential } from "./test-fixtures.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
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
