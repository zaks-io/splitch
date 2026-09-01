import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveContext, writeNearestConfig } from "./context.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

afterEach(async () => {
  await cleanupTempHomes();
});

describe("writeNearestConfig", () => {
  it("updates the ancestor project config instead of shadowing it from a subdirectory", async () => {
    const { dir } = await makeTempHome();
    const rootConfig = join(dir, "splitch.json");
    await writeFile(rootConfig, '{"version":1,"app":"app_a","environment":"env_dev"}\n');
    const subdir = join(dir, "packages", "foo");
    await mkdir(subdir, { recursive: true });

    const written = await writeNearestConfig(subdir, { environment: "env_prod" });

    // Wrote the discovered project config, NOT a new subdir-local file.
    expect(written).toBe(rootConfig);
    const config = JSON.parse(await readFile(rootConfig, "utf8"));
    expect(config).toEqual({ version: 1, app: "app_a", environment: "env_prod" });

    // The App scope survives, resolvable from the subdirectory.
    const context = await resolveContext({ flags: {}, env: {}, cwd: subdir });
    expect(context.appId).toBe("app_a");
    expect(context.environmentId).toBe("env_prod");
  });

  it("creates a cwd-local config when no ancestor config exists", async () => {
    const { dir } = await makeTempHome();
    const subdir = join(dir, "workspace");
    await mkdir(subdir, { recursive: true });

    const written = await writeNearestConfig(subdir, { app: "app_new" });

    expect(written).toBe(join(subdir, "splitch.json"));
    const config = JSON.parse(await readFile(written, "utf8"));
    expect(config).toMatchObject({ version: 1, app: "app_new" });
  });
});
