import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatedPaths } from "./cloudflare-files";
import {
  WRANGLER_ENVIRONMENTS_CONFIG as APP_CONFIG,
  appConfig,
  appWithConfig,
  INSTALLATION_STATUS,
  RecordingRunner,
  recordedState,
  runCloudflare,
  setupCloudflare,
  wranglerTypesConfigs,
} from "./cloudflare-test-fixtures";
import { executeInvocation } from "./execute";
import { parseInvocation } from "./parse-args";

const DEV_TYPES_CONFIGS = ["wrangler.jsonc", ".splitch/cloudflare/dev/wrangler.jsonc"];

describe("cloudflare setup --wrangler-env", () => {
  it("binds the named Wrangler environment while serving the selected splitch Environment", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    const runner = new RecordingRunner();

    const result = await setupCloudflare(cwd, runner, [
      "--env",
      "dev",
      "--wrangler-env",
      "preview",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.payload).toMatchObject({ workerName: "splitch-config-dev" });
    const config = await appConfig(cwd);
    expect(config.env.preview.services).toEqual([
      { binding: "SPLITCH", service: "splitch-config-dev" },
    ]);
    expect(config.env).not.toHaveProperty("dev");
    expect(config.env.production).not.toHaveProperty("services");
    expect(config).not.toHaveProperty("services");
    const deploy = runner.calls.find((call) => call.args.includes("deploy"));
    expect(deploy?.args).toContain(generatedPaths(cwd, "dev").configPath);
    expect(wranglerTypesConfigs(runner)).toEqual(DEV_TYPES_CONFIGS);
    expect((await recordedState(cwd, "dev")).appBindingPath).toEqual([
      "env",
      "preview",
      "services",
    ]);
  });

  it("binds the same path as the default when the names match", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    const runner = new RecordingRunner();

    await setupCloudflare(cwd, runner, ["--env", "preview", "--wrangler-env", "preview"]);

    expect((await appConfig(cwd)).env.preview.services).toEqual([
      { binding: "SPLITCH", service: "splitch-config-preview" },
    ]);
    expect(wranglerTypesConfigs(runner)).toEqual([
      "wrangler.jsonc",
      ".splitch/cloudflare/preview/wrangler.jsonc",
    ]);
  });

  it("fails before deploy when the named Wrangler environment is missing", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    const runner = new RecordingRunner();

    await expect(
      setupCloudflare(cwd, runner, ["--env", "dev", "--wrangler-env", "staging"]),
    ).rejects.toThrow(/Wrangler Environment "staging" does not exist/);
    expect(runner.calls.some((call) => call.args.includes("deploy"))).toBe(false);
  });

  it("does not treat an inherited property as a Wrangler environment", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    const runner = new RecordingRunner();

    await expect(
      setupCloudflare(cwd, runner, ["--env", "dev", "--wrangler-env", "__proto__"]),
    ).rejects.toThrow(/Wrangler Environment "__proto__" does not exist/);
    expect(runner.calls.some((call) => call.args.includes("deploy"))).toBe(false);
  });

  it("never falls back to top-level services for an explicit name", async () => {
    const cwd = await appWithConfig({ name: "customer-app" });
    const runner = new RecordingRunner();

    await expect(
      setupCloudflare(cwd, runner, ["--env", "dev", "--wrangler-env", "preview"]),
    ).rejects.toThrow(/Wrangler Environment "preview" does not exist/);
    expect(runner.calls.some((call) => call.args.includes("deploy"))).toBe(false);
    expect(await appConfig(cwd)).not.toHaveProperty("services");
  });
});

describe("cloudflare reruns against a recorded Wrangler environment", () => {
  it("repairs an exact rerun, with or without the flag, without rebinding", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    await setupCloudflare(cwd, new RecordingRunner(), [
      "--env",
      "dev",
      "--wrangler-env",
      "preview",
    ]);
    const installed = await recordedState(cwd, "dev");

    await setupCloudflare(cwd, new RecordingRunner(), [
      "--env",
      "dev",
      "--wrangler-env",
      "preview",
    ]);
    const runner = new RecordingRunner();
    await setupCloudflare(cwd, runner, ["--env", "dev"]);

    expect(await recordedState(cwd, "dev")).toMatchObject({
      installationId: installed.installationId,
      appBindingPath: ["env", "preview", "services"],
    });
    expect((await appConfig(cwd)).env.preview.services).toHaveLength(1);
    expect(wranglerTypesConfigs(runner)).toEqual(DEV_TYPES_CONFIGS);
  });

  it("fails loud instead of moving the binding to a different Wrangler environment", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    await setupCloudflare(cwd, new RecordingRunner(), [
      "--env",
      "dev",
      "--wrangler-env",
      "preview",
    ]);
    const before = await readFile(join(cwd, "wrangler.jsonc"), "utf8");
    const runner = new RecordingRunner();

    await expect(
      setupCloudflare(cwd, runner, ["--env", "dev", "--wrangler-env", "production"]),
    ).rejects.toThrow(/binds SPLITCH at env\.preview\.services, not Wrangler Environment/);
    expect(runner.calls).toEqual([]);
    expect(await readFile(join(cwd, "wrangler.jsonc"), "utf8")).toBe(before);
  });

  it("reads status through the recorded binding path", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    await setupCloudflare(cwd, new RecordingRunner(), [
      "--env",
      "dev",
      "--wrangler-env",
      "preview",
    ]);

    const result = await runCloudflare(
      cwd,
      new RecordingRunner(),
      ["cloudflare", "status", "--env", "dev"],
      {
        fetch: async () => Response.json(INSTALLATION_STATUS),
      },
    );

    expect(result.payload).toMatchObject({ workerName: "splitch-config-dev", status: "active" });
  });

  it("binds a different Wrangler environment after remove, even once the old one is gone", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    await setupCloudflare(cwd, new RecordingRunner(), [
      "--env",
      "dev",
      "--wrangler-env",
      "preview",
    ]);
    await runCloudflare(cwd, new RecordingRunner(), ["cloudflare", "remove", "--env", "dev"], {
      fetch: async () => Response.json(null),
    });
    await writeFile(
      join(cwd, "wrangler.jsonc"),
      JSON.stringify({ name: "customer-app", env: { production: {} } }),
    );

    await setupCloudflare(cwd, new RecordingRunner(), [
      "--env",
      "dev",
      "--wrangler-env",
      "production",
    ]);

    expect((await appConfig(cwd)).env.production.services).toEqual([
      { binding: "SPLITCH", service: "splitch-config-dev" },
    ]);
    expect(await recordedState(cwd, "dev")).toMatchObject({
      appBindingPath: ["env", "production", "services"],
    });
    expect((await recordedState(cwd, "dev")).removedAt).toBeUndefined();
  });

  it("rejects --wrangler-env on commands that use the recorded binding", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    const errors: string[] = [];

    const result = await executeInvocation(
      parseInvocation(["cloudflare", "remove", "--env", "dev", "--wrangler-env", "preview"]),
      { cwd, io: { log: () => {}, error: (line) => errors.push(line) } },
    );

    expect(result.exitCode).not.toBe(0);
    expect(errors.join("\n")).toContain(
      "--wrangler-env is not accepted by splitch cloudflare remove",
    );
  });
});
