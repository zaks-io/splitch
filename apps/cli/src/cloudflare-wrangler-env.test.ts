import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CloudflareState, generatedPaths, readState, writeState } from "./cloudflare-files";
import {
  cloudflareInstallationFetch,
  INSTALLATION_STATUS,
  installFakeAppPackages,
  RecordingRunner,
} from "./cloudflare-test-fixtures";
import { executeInvocation } from "./execute";
import type { CliResult } from "./execute-types";
import { parseInvocation } from "./parse-args";

const APP_CONFIG = { name: "customer-app", env: { preview: {}, production: {} } };

describe("cloudflare setup --wrangler-env", () => {
  it("binds the named Wrangler environment while serving the selected splitch Environment", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    const runner = new RecordingRunner();

    const result = await setup(cwd, runner, ["--env", "dev", "--wrangler-env", "preview"]);

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
    expect(typesEnv(runner)).toBe("preview");
    expect((await state(cwd, "dev")).appBindingPath).toEqual(["env", "preview", "services"]);
  });

  it("binds the same path as the default when the names match", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    const runner = new RecordingRunner();

    await setup(cwd, runner, ["--env", "preview", "--wrangler-env", "preview"]);

    expect((await appConfig(cwd)).env.preview.services).toEqual([
      { binding: "SPLITCH", service: "splitch-config-preview" },
    ]);
    expect(typesEnv(runner)).toBe("preview");
  });

  it("fails before deploy when the named Wrangler environment is missing", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    const runner = new RecordingRunner();

    await expect(setup(cwd, runner, ["--env", "dev", "--wrangler-env", "staging"])).rejects.toThrow(
      /Wrangler Environment "staging" does not exist/,
    );
    expect(runner.calls.some((call) => call.args.includes("deploy"))).toBe(false);
  });

  it("does not treat an inherited property as a Wrangler environment", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    const runner = new RecordingRunner();

    await expect(
      setup(cwd, runner, ["--env", "dev", "--wrangler-env", "__proto__"]),
    ).rejects.toThrow(/Wrangler Environment "__proto__" does not exist/);
    expect(runner.calls.some((call) => call.args.includes("deploy"))).toBe(false);
  });

  it("never falls back to top-level services for an explicit name", async () => {
    const cwd = await appWithConfig({ name: "customer-app" });
    const runner = new RecordingRunner();

    await expect(setup(cwd, runner, ["--env", "dev", "--wrangler-env", "preview"])).rejects.toThrow(
      /Wrangler Environment "preview" does not exist/,
    );
    expect(runner.calls.some((call) => call.args.includes("deploy"))).toBe(false);
    expect(await appConfig(cwd)).not.toHaveProperty("services");
  });
});

describe("cloudflare reruns against a recorded Wrangler environment", () => {
  it("repairs an exact rerun, with or without the flag, without rebinding", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    await setup(cwd, new RecordingRunner(), ["--env", "dev", "--wrangler-env", "preview"]);
    const installed = await state(cwd, "dev");

    await setup(cwd, new RecordingRunner(), ["--env", "dev", "--wrangler-env", "preview"]);
    const runner = new RecordingRunner();
    await setup(cwd, runner, ["--env", "dev"]);

    expect(await state(cwd, "dev")).toMatchObject({
      installationId: installed.installationId,
      appBindingPath: ["env", "preview", "services"],
    });
    expect((await appConfig(cwd)).env.preview.services).toHaveLength(1);
    expect(typesEnv(runner)).toBe("preview");
  });

  it("fails loud instead of moving the binding to a different Wrangler environment", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    await setup(cwd, new RecordingRunner(), ["--env", "dev", "--wrangler-env", "preview"]);
    const before = await readFile(join(cwd, "wrangler.jsonc"), "utf8");
    const runner = new RecordingRunner();

    await expect(
      setup(cwd, runner, ["--env", "dev", "--wrangler-env", "production"]),
    ).rejects.toThrow(/binds SPLITCH at env\.preview\.services, not Wrangler Environment/);
    expect(runner.calls).toEqual([]);
    expect(await readFile(join(cwd, "wrangler.jsonc"), "utf8")).toBe(before);
  });

  it("reads status through the recorded binding path", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    await setup(cwd, new RecordingRunner(), ["--env", "dev", "--wrangler-env", "preview"]);

    const result = await run(cwd, new RecordingRunner(), ["cloudflare", "status", "--env", "dev"], {
      fetch: async () => Response.json(INSTALLATION_STATUS),
    });

    expect(result.payload).toMatchObject({ workerName: "splitch-config-dev", status: "active" });
  });

  it("removes the binding from the recorded Wrangler environment", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    await setup(cwd, new RecordingRunner(), ["--env", "dev", "--wrangler-env", "preview"]);
    const runner = new RecordingRunner();

    await run(cwd, runner, ["cloudflare", "remove", "--env", "dev"], {
      fetch: async () => Response.json(null),
    });

    expect((await appConfig(cwd)).env.preview.services).toEqual([]);
    expect(typesEnv(runner)).toBe("preview");
    expect((await state(cwd, "dev")).removedAt).toEqual(expect.any(String));
  });

  it("binds a different Wrangler environment after remove, even once the old one is gone", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    await setup(cwd, new RecordingRunner(), ["--env", "dev", "--wrangler-env", "preview"]);
    await run(cwd, new RecordingRunner(), ["cloudflare", "remove", "--env", "dev"], {
      fetch: async () => Response.json(null),
    });
    await writeFile(
      join(cwd, "wrangler.jsonc"),
      JSON.stringify({ name: "customer-app", env: { production: {} } }),
    );

    await setup(cwd, new RecordingRunner(), ["--env", "dev", "--wrangler-env", "production"]);

    expect((await appConfig(cwd)).env.production.services).toEqual([
      { binding: "SPLITCH", service: "splitch-config-dev" },
    ]);
    expect(await state(cwd, "dev")).toMatchObject({
      appBindingPath: ["env", "production", "services"],
    });
    expect((await state(cwd, "dev")).removedAt).toBeUndefined();
  });

  it("rejects a state file forged to bind an inherited property", async () => {
    const cwd = await appWithConfig(APP_CONFIG);
    await setup(cwd, new RecordingRunner(), ["--env", "dev", "--wrangler-env", "preview"]);
    const forged = {
      ...(await state(cwd, "dev")),
      appBindingPath: ["env", "__proto__", "services"],
    };
    await writeState(generatedPaths(cwd, "dev").statePath, forged);
    const requests: string[] = [];
    const runner = new RecordingRunner();

    await expect(
      run(cwd, runner, ["cloudflare", "remove", "--env", "dev"], {
        fetch: async (request) => {
          requests.push(String(request));
          return Response.json(null);
        },
      }),
    ).rejects.toThrow(/Wrangler Environment "__proto__" does not exist/);
    expect(requests).toEqual([]);
    expect(runner.calls).toEqual([]);
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

async function appWithConfig(config: object): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "splitch-cloudflare-wrangler-env-"));
  await installFakeAppPackages(cwd);
  await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify(config));
  return cwd;
}

function setup(cwd: string, runner: RecordingRunner, flags: readonly string[]) {
  return run(cwd, runner, ["cloudflare", "setup", ...flags, "--json"], {
    fetch: cloudflareInstallationFetch(),
  });
}

function run(
  cwd: string,
  runner: RecordingRunner,
  args: readonly string[],
  options: { readonly fetch: typeof fetch },
): Promise<CliResult> {
  return executeInvocation(parseInvocation(args), {
    cwd,
    env: { SPLITCH_API_KEY: "api-key" },
    platformTarget: "local",
    evaluationBaseUrl: "http://127.0.0.1:8788",
    fetch: options.fetch,
    commandRunner: runner,
    sleep: async () => {},
    io: { log: () => {}, error: () => {} },
  });
}

async function appConfig(cwd: string) {
  return JSON.parse(await readFile(join(cwd, "wrangler.jsonc"), "utf8"));
}

async function state(cwd: string, environment: string): Promise<CloudflareState> {
  const recorded = await readState(generatedPaths(cwd, environment).statePath);
  if (!recorded) throw new Error(`No Cloudflare state for ${environment}`);
  return recorded;
}

function typesEnv(runner: RecordingRunner): string | undefined {
  const args = runner.calls.find((call) => call.args.includes("types"))?.args ?? [];
  const index = args.indexOf("--env");
  return index === -1 ? undefined : args[index + 1];
}
