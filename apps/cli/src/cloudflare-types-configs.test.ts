import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { generatedPaths } from "./cloudflare-files";
import {
  WRANGLER_ENVIRONMENTS_CONFIG as APP_CONFIG,
  appWithConfig,
  RecordingRunner,
  runCloudflare,
  setupCloudflare,
  wranglerTypesConfigs,
} from "./cloudflare-test-fixtures";

const DEV = ".splitch/cloudflare/dev/wrangler.jsonc";
const PRODUCTION = ".splitch/cloudflare/production/wrangler.jsonc";

describe("cloudflare types runs include every bound integration", () => {
  it("keeps another Environment's integration typed, even on a clone without its state file", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    await setupCloudflare(cwd, new RecordingRunner(), ["--env", "production"]);
    await rm(generatedPaths(cwd, "production").statePath);
    const runner = new RecordingRunner();

    const result = await setupCloudflare(cwd, runner, [
      "--env",
      "dev",
      "--wrangler-env",
      "preview",
    ]);

    expect(wranglerTypesConfigs(runner)).toEqual(["wrangler.jsonc", DEV, PRODUCTION]);
    expect(result.payload).toMatchObject({
      typesCommand: `wrangler types --config wrangler.jsonc --config ${DEV} --config ${PRODUCTION}`,
    });
  });

  it("ignores integration directories the application config does not bind", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    await mkdir(generatedPaths(cwd, "staging").directory, { recursive: true });
    await writeFile(generatedPaths(cwd, "staging").configPath, "{}");
    await mkdir(`${cwd}/.splitch/cloudflare/dev copy`, { recursive: true });
    const runner = new RecordingRunner();

    await setupCloudflare(cwd, runner, ["--env", "dev", "--wrangler-env", "preview"]);

    expect(wranglerTypesConfigs(runner)).toEqual(["wrangler.jsonc", DEV]);
  });

  it("fails before deploy when a bound integration's config is missing", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    await setupCloudflare(cwd, new RecordingRunner(), ["--env", "production"]);
    await rm(generatedPaths(cwd, "production").configPath);
    const runner = new RecordingRunner();

    await expect(
      setupCloudflare(cwd, runner, ["--env", "dev", "--wrangler-env", "preview"]),
    ).rejects.toThrow(/binds splitch-config-production, but no .* generates it/);
    expect(runner.calls.some((call) => call.args.includes("deploy"))).toBe(false);
  });

  it("fails before deploy when two directories generate the same bound Worker", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    await setupCloudflare(cwd, new RecordingRunner(), ["--env", "production"]);
    await mkdir(`${cwd}/.splitch/cloudflare/production.`, { recursive: true });
    await writeFile(`${cwd}/.splitch/cloudflare/production./wrangler.jsonc`, "{}");
    const runner = new RecordingRunner();

    await expect(
      setupCloudflare(cwd, runner, ["--env", "dev", "--wrangler-env", "preview"]),
    ).rejects.toThrow(/binds splitch-config-production, which .* all generate/);
    expect(runner.calls.some((call) => call.args.includes("deploy"))).toBe(false);
  });
});

describe("cloudflare setup checks its own integration before deploy", () => {
  it("regenerates its own deleted directory while the App still binds its Worker", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    await setupCloudflare(cwd, new RecordingRunner(), [
      "--env",
      "dev",
      "--wrangler-env",
      "preview",
    ]);
    await rm(generatedPaths(cwd, "dev").directory, { recursive: true });
    const runner = new RecordingRunner();

    await setupCloudflare(cwd, runner, ["--env", "dev", "--wrangler-env", "preview"]);

    expect(wranglerTypesConfigs(runner)).toEqual(["wrangler.jsonc", DEV]);
  });

  it("fails before deploy when another directory already generates its Worker", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    await mkdir(`${cwd}/.splitch/cloudflare/production.`, { recursive: true });
    await writeFile(`${cwd}/.splitch/cloudflare/production./wrangler.jsonc`, "{}");
    const runner = new RecordingRunner();

    await expect(setupCloudflare(cwd, runner, ["--env", "production"])).rejects.toThrow(
      /binds splitch-config-production, which .* all generate/,
    );
    expect(runner.calls.some((call) => call.args.includes("deploy"))).toBe(false);
  });
});

describe("cloudflare remove regenerates types before deleting the Worker", () => {
  it("drops only the removed integration and leaves fresh types if the delete fails", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    await setupCloudflare(cwd, new RecordingRunner(), ["--env", "production"]);
    await setupCloudflare(cwd, new RecordingRunner(), [
      "--env",
      "dev",
      "--wrangler-env",
      "preview",
    ]);
    const runner = new FailingDeleteRunner();

    await expect(
      runCloudflare(cwd, runner, ["cloudflare", "remove", "--env", "dev"], {
        fetch: async () => Response.json(null),
      }),
    ).rejects.toThrow(/Wrangler failed: delete failed/);

    expect(wranglerTypesConfigs(runner)).toEqual(["wrangler.jsonc", PRODUCTION]);
  });

  it("puts the binding back when the types run fails, so a rerun regenerates them", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    await setupCloudflare(cwd, new RecordingRunner(), [
      "--env",
      "dev",
      "--wrangler-env",
      "preview",
    ]);
    const before = await readFile(`${cwd}/wrangler.jsonc`, "utf8");
    const runner = new FailingTypesOnceRunner();
    const remove = () =>
      runCloudflare(cwd, runner, ["cloudflare", "remove", "--env", "dev"], {
        fetch: async () => Response.json(null),
      });

    await expect(remove()).rejects.toThrow(/Wrangler failed: types failed/);
    expect(await readFile(`${cwd}/wrangler.jsonc`, "utf8")).toBe(before);
    expect(runner.calls.some((call) => call.args.includes("delete"))).toBe(false);

    await remove();

    expect(runner.calls.filter((call) => call.args.includes("types"))).toHaveLength(2);
    expect(runner.calls.some((call) => call.args.includes("delete"))).toBe(true);
  });

  it("changes nothing when another bound integration's config is missing", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    await setupCloudflare(cwd, new RecordingRunner(), ["--env", "production"]);
    await setupCloudflare(cwd, new RecordingRunner(), [
      "--env",
      "dev",
      "--wrangler-env",
      "preview",
    ]);
    await rm(generatedPaths(cwd, "production").configPath);
    const before = await readFile(`${cwd}/wrangler.jsonc`, "utf8");
    const runner = new RecordingRunner();
    const requests: string[] = [];

    await expect(
      runCloudflare(cwd, runner, ["cloudflare", "remove", "--env", "dev"], {
        fetch: async (_input, init) => {
          requests.push(init?.method ?? "GET");
          return Response.json(null);
        },
      }),
    ).rejects.toThrow(/binds splitch-config-production, but no .* generates it/);

    expect(requests).toEqual([]);
    expect(runner.calls).toEqual([]);
    expect(await readFile(`${cwd}/wrangler.jsonc`, "utf8")).toBe(before);
  });
});

class FailingTypesOnceRunner extends RecordingRunner {
  private failed = false;

  override async run(command: string, args: readonly string[], options: { cwd: string }) {
    if (!args.includes("types") || this.failed) return super.run(command, args, options);
    this.failed = true;
    this.calls.push({ command, args });
    return { exitCode: 1, stdout: "", stderr: "types failed" };
  }
}

class FailingDeleteRunner extends RecordingRunner {
  override async run(command: string, args: readonly string[], options: { cwd: string }) {
    if (!args.includes("delete")) return super.run(command, args, options);
    this.calls.push({ command, args });
    return { exitCode: 1, stdout: "", stderr: "delete failed" };
  }
}
