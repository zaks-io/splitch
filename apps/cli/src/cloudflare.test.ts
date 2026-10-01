import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CloudflareState, generatedPaths, writeState } from "./cloudflare-files";
import {
  cloudflareInstallationFetch,
  cloudflareState,
  installFakeAppPackages,
  installFakeCloudflarePackage,
  installFakeWrangler,
  RecordingRunner,
  wranglerTypesConfigs,
} from "./cloudflare-test-fixtures";
import { executeInvocation } from "./execute";
import { parseInvocation } from "./parse-args";

describe("cloudflare setup", () => {
  it("deploys, registers, waits for push, and installs the service binding", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "splitch-cloudflare-cli-"));
    await installFakeAppPackages(cwd);
    await writeFile(
      join(cwd, "wrangler.jsonc"),
      '{\n  // customer configuration\n  "name": "customer-app",\n  "env": { "production": { "vars": { "MODE": "production" } } }\n}\n',
    );
    const runner = new RecordingRunner();
    const requests: Array<{ url: string; method: string }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (method === "POST") return Response.json({ registered: true });
      if (requests.length === 1)
        return Response.json(
          {
            code: "CLOUDFLARE_INSTALLATION_NOT_FOUND",
            message: "Cloudflare installation not found",
            details: {},
          },
          { status: 404 },
        );
      return Response.json({
        installationId: "00000000-0000-4000-8000-000000000000",
        appId: "app_1",
        environmentId: "env_1",
        environmentVersion: 7,
        status: "active",
        endpoint:
          "https://splitch-config-production.customer.workers.dev/integrations/splitch/configuration",
        lastAppliedVersion: 7,
        lastAppliedAt: "2026-08-25T00:00:00.000Z",
        pendingCount: 0,
        oldestPendingAgeMs: null,
        terminalCount: 0,
        latestDeliveryError: null,
      });
    };
    const output: string[] = [];

    const result = await executeInvocation(
      parseInvocation(["cloudflare", "setup", "--env", "production", "--json"]),
      {
        cwd,
        env: { SPLITCH_API_KEY: "api-key" },
        fetch: fetcher,
        platformTarget: "local",
        evaluationBaseUrl: "http://127.0.0.1:8788",
        commandRunner: runner,
        sleep: async () => {},
        io: { log: (line) => output.push(line), error: (line) => output.push(line) },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(requests.map(({ method }) => method)).toEqual(["GET", "POST", "GET"]);
    expect(requests[1]?.url).toBe(
      "http://127.0.0.1:8788/api/integrations/cloudflare/installations",
    );
    const applicationConfig = await readFile(join(cwd, "wrangler.jsonc"), "utf8");
    expect(applicationConfig).toContain("// customer configuration");
    expect(applicationConfig).toContain('"binding": "SPLITCH"');
    expect(applicationConfig).toContain('"service": "splitch-config-production"');
    expect(
      JSON.parse(applicationConfig.replace("// customer configuration", "")),
    ).not.toHaveProperty("services");
    await expect(readFile(join(cwd, ".gitignore"), "utf8")).resolves.toContain(
      ".splitch/cloudflare/*/state.json",
    );
    expect(runner.secretInputs).toEqual([
      "api-key\n",
      expect.stringMatching(/^[A-Za-z0-9_-]{43}\n$/),
    ]);
    expect(wranglerTypesConfigs(runner)).toEqual([
      "wrangler.jsonc",
      ".splitch/cloudflare/production/wrangler.jsonc",
    ]);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      workerName: "splitch-config-production",
      environmentVersion: 7,
      appliedEnvironmentVersion: 7,
      typesCommand:
        "wrangler types --config wrangler.jsonc --config .splitch/cloudflare/production/wrangler.jsonc",
    });
  });

  it("fails before deploy when SPLITCH already belongs to another Worker", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "splitch-cloudflare-cli-collision-"));
    await installFakeAppPackages(cwd);
    await writeFile(
      join(cwd, "wrangler.jsonc"),
      JSON.stringify({
        name: "customer-app",
        services: [{ binding: "SPLITCH", service: "customer-owned-worker" }],
      }),
    );
    const runner = new RecordingRunner();

    await expect(
      executeInvocation(parseInvocation(["cloudflare", "setup", "--env", "production"]), {
        cwd,
        env: { SPLITCH_API_KEY: "api-key" },
        commandRunner: runner,
        io: { log: () => {}, error: () => {} },
      }),
    ).rejects.toThrow(/SPLITCH is already bound to "customer-owned-worker"/);
    expect(runner.calls.some((call) => call.args.includes("deploy"))).toBe(false);
  });

  it("fails before deploy when the API Key is rejected", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "splitch-cloudflare-cli-api-key-"));
    await installFakeAppPackages(cwd);
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify({ name: "customer-app" }));
    const runner = new RecordingRunner();

    await expect(
      executeInvocation(parseInvocation(["cloudflare", "setup", "--env", "production"]), {
        cwd,
        env: { SPLITCH_API_KEY: "invalid-api-key" },
        platformTarget: "local",
        evaluationBaseUrl: "http://127.0.0.1:8788",
        fetch: async () => Response.json({}, { status: 401 }),
        commandRunner: runner,
        io: { log: () => {}, error: () => {} },
      }),
    ).rejects.toThrow(/HTTP 401/);
    expect(runner.calls.some((call) => call.args.includes("deploy"))).toBe(false);
    await expect(
      readFile(join(cwd, ".splitch", "cloudflare", "production", "wrangler.jsonc"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("cloudflare wrangler resolution", () => {
  it("runs the App's own wrangler under Node so any package manager works", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "splitch-cloudflare-cli-runner-"));
    await installFakeAppPackages(cwd);
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify({ name: "customer-app" }));
    const runner = new RecordingRunner();

    await executeInvocation(parseInvocation(["cloudflare", "setup", "--env", "production"]), {
      cwd,
      env: { SPLITCH_API_KEY: "api-key" },
      platformTarget: "local",
      evaluationBaseUrl: "http://127.0.0.1:8788",
      fetch: cloudflareInstallationFetch(),
      commandRunner: runner,
      sleep: async () => {},
      io: { log: () => {}, error: () => {} },
    });

    const bin = join(await realpath(cwd), "node_modules", "wrangler", "bin", "wrangler.js");
    expect(runner.calls.length).toBeGreaterThan(0);
    for (const call of runner.calls) {
      expect(call.command).toBe(process.execPath);
      expect(call.args[0]).toBe(bin);
    }
  });

  it("falls back to a globally installed wrangler when the App has none", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "splitch-cloudflare-cli-global-"));
    await installFakeCloudflarePackage(cwd);
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify({ name: "customer-app" }));
    const runner = new RecordingRunner();

    await executeInvocation(parseInvocation(["cloudflare", "setup", "--env", "production"]), {
      cwd,
      env: { SPLITCH_API_KEY: "api-key" },
      platformTarget: "local",
      evaluationBaseUrl: "http://127.0.0.1:8788",
      fetch: cloudflareInstallationFetch(),
      commandRunner: runner,
      sleep: async () => {},
      io: { log: () => {}, error: () => {} },
    });

    expect(runner.calls.length).toBeGreaterThan(0);
    for (const call of runner.calls) expect(call.command).toBe("wrangler");
    expect(runner.calls[0]?.args).toEqual(["--version"]);
  });

  it("resolves a wrangler that declares its executable as a bare bin string", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "splitch-cloudflare-cli-binstring-"));
    await installFakeCloudflarePackage(cwd);
    await installFakeWrangler(cwd, "./bin/wrangler.js");
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify({ name: "customer-app" }));
    const runner = new RecordingRunner();

    await executeInvocation(parseInvocation(["cloudflare", "setup", "--env", "production"]), {
      cwd,
      env: { SPLITCH_API_KEY: "api-key" },
      platformTarget: "local",
      evaluationBaseUrl: "http://127.0.0.1:8788",
      fetch: cloudflareInstallationFetch(),
      commandRunner: runner,
      sleep: async () => {},
      io: { log: () => {}, error: () => {} },
    });

    const bin = join(await realpath(cwd), "node_modules", "wrangler", "bin", "wrangler.js");
    expect(runner.calls[0]).toMatchObject({ command: process.execPath, args: [bin, "--version"] });
  });

  it("reports the version it actually found instead of repeating install advice", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "splitch-cloudflare-cli-old-wrangler-"));
    await installFakeAppPackages(cwd);
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify({ name: "customer-app" }));

    await expect(
      executeInvocation(parseInvocation(["cloudflare", "setup", "--env", "production"]), {
        cwd,
        env: { SPLITCH_API_KEY: "api-key" },
        commandRunner: {
          run: async () => ({ exitCode: 0, stdout: "3.114.17\n", stderr: "" }),
        },
        io: { log: () => {}, error: () => {} },
      }),
    ).rejects.toThrow(/3\.114\.17/);
  });

  it("propagates a non-ENOENT spawn failure instead of blaming a missing wrangler", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "splitch-cloudflare-cli-eacces-"));
    await installFakeCloudflarePackage(cwd);
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify({ name: "customer-app" }));

    await expect(
      executeInvocation(parseInvocation(["cloudflare", "setup", "--env", "production"]), {
        cwd,
        env: { SPLITCH_API_KEY: "api-key" },
        commandRunner: {
          run: async () => {
            throw Object.assign(new Error("spawn wrangler EACCES"), { code: "EACCES" });
          },
        },
        io: { log: () => {}, error: () => {} },
      }),
    ).rejects.toThrow(/EACCES/);
  });

  it("fails loudly when wrangler is installed neither in the App nor on PATH", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "splitch-cloudflare-cli-no-wrangler-"));
    await installFakeCloudflarePackage(cwd);
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify({ name: "customer-app" }));

    await expect(
      executeInvocation(parseInvocation(["cloudflare", "setup", "--env", "production"]), {
        cwd,
        env: { SPLITCH_API_KEY: "api-key" },
        commandRunner: {
          run: async () => {
            throw Object.assign(new Error("spawn wrangler ENOENT"), { code: "ENOENT" });
          },
        },
        io: { log: () => {}, error: () => {} },
      }),
    ).rejects.toThrow(/Wrangler 4 is required/);
  });
});

describe("cloudflare setup preflight", () => {
  it("fails before deploy when an unrelated endpoint returns 404", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "splitch-cloudflare-cli-route-"));
    await installFakeAppPackages(cwd);
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify({ name: "customer-app" }));
    const runner = new RecordingRunner();

    await expect(
      executeInvocation(parseInvocation(["cloudflare", "setup", "--env", "production"]), {
        cwd,
        env: { SPLITCH_API_KEY: "api-key" },
        platformTarget: "local",
        evaluationBaseUrl: "http://127.0.0.1:9999",
        fetch: async () => Response.json({}, { status: 404 }),
        commandRunner: runner,
        io: { log: () => {}, error: () => {} },
      }),
    ).rejects.toThrow(/expected authenticated contract/);
    expect(runner.calls.some((call) => call.args.includes("deploy"))).toBe(false);
    await expect(
      readFile(join(cwd, ".splitch", "cloudflare", "production", "wrangler.jsonc"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails instead of silently binding the root config for an unknown Wrangler Environment", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "splitch-cloudflare-cli-environment-"));
    await installFakeAppPackages(cwd);
    await writeFile(
      join(cwd, "wrangler.jsonc"),
      JSON.stringify({ name: "customer-app", env: { production: {} } }),
    );
    const runner = new RecordingRunner();

    await expect(
      executeInvocation(parseInvocation(["cloudflare", "setup", "--env", "env_1"]), {
        cwd,
        env: { SPLITCH_API_KEY: "api-key" },
        commandRunner: runner,
        io: { log: () => {}, error: () => {} },
      }),
    ).rejects.toThrow(/Wrangler Environment "env_1" does not exist/);
    expect(runner.calls.some((call) => call.args.includes("deploy"))).toBe(false);
  });
});

describe("cloudflare remove preflight", () => {
  it("rejects a linked App config before touching its external target", async () => {
    const root = await mkdtemp(join(tmpdir(), "splitch-cloudflare-remove-link-"));
    const cwd = join(root, "app");
    await mkdir(cwd);
    const externalConfig = join(root, "external.jsonc");
    const original = JSON.stringify({
      name: "external-app",
      services: [{ binding: "SPLITCH", service: "splitch-config-production" }],
    });
    await writeFile(externalConfig, original);
    await symlink(externalConfig, join(cwd, "wrangler.jsonc"));
    await writeState(generatedPaths(cwd, "production").statePath, cloudflareState(cwd));
    const requests: string[] = [];
    const runner = new RecordingRunner();

    await expect(
      executeInvocation(parseInvocation(["cloudflare", "remove", "--env", "production"]), {
        cwd,
        env: { SPLITCH_API_KEY: "api-key" },
        fetch: async (request) => {
          requests.push(String(request));
          return Response.json(null);
        },
        commandRunner: runner,
        io: { log: () => {}, error: () => {} },
      }),
    ).rejects.toThrow(/regular file, not a link/);

    expect(requests).toEqual([]);
    expect(runner.calls).toEqual([]);
    expect(await readFile(externalConfig, "utf8")).toBe(original);
  });

  it.each([
    {
      name: "Worker name",
      mutate: (state: CloudflareState) => ({ ...state, workerName: "customer-worker" }),
    },
    {
      name: "App config path",
      mutate: (state: CloudflareState) => ({
        ...state,
        appConfigPath: "/tmp/other/wrangler.jsonc",
      }),
    },
    {
      name: "service binding path",
      mutate: (state: CloudflareState) => ({ ...state, appBindingPath: ["unsafe", "services"] }),
    },
  ])("rejects a forged $name before any mutation", async ({ mutate }) => {
    const cwd = await mkdtemp(join(tmpdir(), "splitch-cloudflare-remove-state-"));
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify({ name: "customer-app" }));
    const state = mutate(cloudflareState(cwd));
    await writeState(generatedPaths(cwd, "production").statePath, state);
    const requests: string[] = [];
    const runner = new RecordingRunner();

    await expect(
      executeInvocation(parseInvocation(["cloudflare", "remove", "--env", "production"]), {
        cwd,
        env: { SPLITCH_API_KEY: "api-key" },
        fetch: async (request) => {
          requests.push(String(request));
          return Response.json(null);
        },
        commandRunner: runner,
        io: { log: () => {}, error: () => {} },
      }),
    ).rejects.toThrow();

    expect(requests).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  it("refuses a reassigned SPLITCH binding before deleting the remote installation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "splitch-cloudflare-remove-binding-"));
    await writeFile(
      join(cwd, "wrangler.jsonc"),
      JSON.stringify({
        name: "customer-app",
        services: [{ binding: "SPLITCH", service: "customer-worker" }],
      }),
    );
    await writeState(generatedPaths(cwd, "production").statePath, cloudflareState(cwd));
    const requests: string[] = [];

    await expect(
      executeInvocation(parseInvocation(["cloudflare", "remove", "--env", "production"]), {
        cwd,
        env: { SPLITCH_API_KEY: "api-key" },
        fetch: async (request) => {
          requests.push(String(request));
          return Response.json(null);
        },
        commandRunner: new RecordingRunner(),
        io: { log: () => {}, error: () => {} },
      }),
    ).rejects.toThrow(/no longer points/);

    expect(requests).toEqual([]);
  });
});
