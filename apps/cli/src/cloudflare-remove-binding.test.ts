import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatedPaths, writeState } from "./cloudflare-files";
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

describe("cloudflare remove against a recorded Wrangler environment", () => {
  it("removes the binding from the recorded Wrangler environment", async () => {
    const cwd = await installedInPreview();
    const runner = new RecordingRunner();

    await remove(cwd, runner);

    expect((await appConfig(cwd)).env.preview.services).toEqual([]);
    expect(wranglerTypesConfigs(runner)).toEqual(["wrangler.jsonc"]);
    expect((await recordedState(cwd, "dev")).removedAt).toEqual(expect.any(String));
  });

  it("removes the integration after its Wrangler environment is deleted", async () => {
    const cwd = await installedInPreview();
    await writeConfig(cwd, { name: "customer-app", env: { production: {} } });
    const runner = new RecordingRunner();
    const requests: string[] = [];

    await remove(cwd, runner, requests);

    expect(requests).toEqual(["DELETE"]);
    expect(runner.calls.some((call) => call.args.includes("delete"))).toBe(true);
    expect(wranglerTypesConfigs(runner)).toBeUndefined();
    expect(await appConfig(cwd)).toEqual({ name: "customer-app", env: { production: {} } });
    expect((await recordedState(cwd, "dev")).removedAt).toEqual(expect.any(String));
  });

  it("points setup and status at remove once the recorded Wrangler environment is gone", async () => {
    const cwd = await installedInPreview();
    await writeConfig(cwd, { name: "customer-app", env: { staging: {} } });
    const stale =
      /binds SPLITCH at env\.preview\.services, which no longer matches .*; run splitch cloudflare remove --env dev/;

    await expect(
      setupCloudflare(cwd, new RecordingRunner(), ["--env", "dev", "--wrangler-env", "staging"]),
    ).rejects.toThrow(stale);
    await expect(
      runCloudflare(cwd, new RecordingRunner(), ["cloudflare", "status", "--env", "dev"], {
        fetch: async () => Response.json(INSTALLATION_STATUS),
      }),
    ).rejects.toThrow(stale);
  });

  it("removes a top-level binding after the config gains an env block", async () => {
    const cwd = await appWithConfig({ name: "customer-app" });
    await setupCloudflare(cwd, new RecordingRunner(), ["--env", "dev"]);
    await writeConfig(cwd, { ...(await appConfig(cwd)), env: { production: {} } });
    const runner = new RecordingRunner();

    await remove(cwd, runner);

    expect((await appConfig(cwd)).services).toEqual([]);
    expect(wranglerTypesConfigs(runner)).toEqual(["wrangler.jsonc"]);
  });

  it("leaves the application config and its types alone when the binding is already gone", async () => {
    const cwd = await installedInPreview();
    const config = await appConfig(cwd);
    config.env.preview.services = [];
    await writeConfig(cwd, config);
    const before = await readFile(join(cwd, "wrangler.jsonc"), "utf8");
    const runner = new RecordingRunner();

    await remove(cwd, runner);

    expect(runner.calls.some((call) => call.args.includes("delete"))).toBe(true);
    expect(wranglerTypesConfigs(runner)).toBeUndefined();
    expect(await readFile(join(cwd, "wrangler.jsonc"), "utf8")).toBe(before);
    expect((await recordedState(cwd, "dev")).removedAt).toEqual(expect.any(String));
  });
});

describe("cloudflare remove refuses to orphan a binding", () => {
  it("refuses while a renamed Wrangler environment still carries the binding", async () => {
    const cwd = await installedInPreview();
    const { preview, ...rest } = (await appConfig(cwd)).env;
    await writeConfig(cwd, { name: "customer-app", env: { ...rest, staging: preview } });

    await expectRemoveRefused(
      cwd,
      /splitch-config-dev is still bound at env\.staging\.services \(SPLITCH\)/,
    );
  });

  it("refuses while any other binding points at the Worker", async () => {
    const cwd = await installedInPreview();
    const config = await appConfig(cwd);
    config.services = [{ binding: "FLAGS", service: "splitch-config-dev" }];
    config.env.production.services = [{ binding: "SPLITCH", service: "splitch-config-dev" }];
    await writeConfig(cwd, config);

    await expectRemoveRefused(
      cwd,
      /still bound at services \(FLAGS\), env\.production\.services \(SPLITCH\)/,
    );
  });

  it("rejects a state file forged to bind an inherited property without touching the config", async () => {
    const cwd = await installedInPreview();
    const forged = {
      ...(await recordedState(cwd, "dev")),
      appBindingPath: ["env", "__proto__", "services"],
    };
    await writeState(generatedPaths(cwd, "dev").statePath, forged);

    await expectRemoveRefused(cwd, /Cloudflare state points at an unexpected service binding/);
  });
});

async function installedInPreview(): Promise<string> {
  const cwd = await appWithConfig(APP_CONFIG);
  await setupCloudflare(cwd, new RecordingRunner(), ["--env", "dev", "--wrangler-env", "preview"]);
  return cwd;
}

function remove(cwd: string, runner: RecordingRunner, requests: string[] = []) {
  return runCloudflare(cwd, runner, ["cloudflare", "remove", "--env", "dev"], {
    fetch: async (_request, init) => {
      requests.push(init?.method ?? "GET");
      return Response.json(null);
    },
  });
}

async function expectRemoveRefused(cwd: string, message: RegExp): Promise<void> {
  const before = await readFile(join(cwd, "wrangler.jsonc"), "utf8");
  const runner = new RecordingRunner();
  const requests: string[] = [];

  await expect(remove(cwd, runner, requests)).rejects.toThrow(message);

  expect(requests).toEqual([]);
  expect(runner.calls).toEqual([]);
  expect(await readFile(join(cwd, "wrangler.jsonc"), "utf8")).toBe(before);
  expect((await recordedState(cwd, "dev")).removedAt).toBeUndefined();
}

function writeConfig(cwd: string, config: object): Promise<void> {
  return writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify(config));
}
