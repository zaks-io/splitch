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

  it("reads and updates the nearest config when multiple ancestors contain one", async () => {
    const { dir } = await makeTempHome();
    const rootConfig = join(dir, "splitch.json");
    const packageDir = join(dir, "packages", "checkout");
    const packageConfig = join(packageDir, "splitch.json");
    const subdir = join(packageDir, "src");
    await mkdir(subdir, { recursive: true });
    await writeFile(rootConfig, '{"version":1,"app":"app_root"}\n');
    await writeFile(packageConfig, '{"version":1,"app":"app_checkout","environment":"env_dev"}\n');

    const context = await resolveContext({ flags: {}, env: {}, cwd: subdir });
    const written = await writeNearestConfig(subdir, { environment: "env_prod" });

    expect(context).toMatchObject({
      appId: "app_checkout",
      environmentId: "env_dev",
      configPath: packageConfig,
    });
    expect(written).toBe(packageConfig);
    expect(JSON.parse(await readFile(packageConfig, "utf8"))).toEqual({
      version: 1,
      app: "app_checkout",
      environment: "env_prod",
    });
    expect(JSON.parse(await readFile(rootConfig, "utf8"))).toEqual({
      version: 1,
      app: "app_root",
    });
  });
});

describe("discovered config validation", () => {
  it.each([
    ["null", "null"],
    ["an array", "[]"],
    ["a missing version", '{"app":"app_checkout"}'],
    ["an unsupported version", '{"version":2,"app":"app_checkout"}'],
    ["a missing App", '{"version":1}'],
    ["an empty App", '{"version":1,"app":"  "}'],
    ["a non-string App", '{"version":1,"app":42}'],
    ["an empty Environment", '{"version":1,"app":"app_checkout","environment":""}'],
    ["a non-string Environment", '{"version":1,"app":"app_checkout","environment":42}'],
  ])("fails loudly for %s instead of falling through to a parent", async (_name, contents) => {
    const { dir } = await makeTempHome();
    const projectDir = join(dir, "project");
    const subdir = join(projectDir, "src");
    await mkdir(subdir, { recursive: true });
    await writeFile(join(dir, "splitch.json"), '{"version":1,"app":"app_parent"}\n');
    await writeFile(join(projectDir, "splitch.json"), `${contents}\n`);

    await expect(resolveContext({ flags: {}, env: {}, cwd: subdir })).rejects.toMatchObject({
      code: "CLI_CONFIG_READ_FAILED",
    });
  });

  it("fails loudly for malformed JSON", async () => {
    const { dir } = await makeTempHome();
    await writeFile(join(dir, "splitch.json"), '{"version":1,"app":');

    await expect(resolveContext({ flags: {}, env: {}, cwd: dir })).rejects.toMatchObject({
      code: "CLI_CONFIG_READ_FAILED",
    });
  });
});
