import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeInvocation } from "./execute";
import type { CliCommandRunner } from "./execute-types";
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
        evaluationBaseUrl: "https://edge.example.test",
        commandRunner: runner,
        sleep: async () => {},
        io: { log: (line) => output.push(line), error: (line) => output.push(line) },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(requests.map(({ method }) => method)).toEqual(["GET", "POST", "GET"]);
    expect(requests[1]?.url).toBe(
      "https://edge.example.test/api/integrations/cloudflare/installations",
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
    expect(runner.calls.some((call) => call.args.includes("types"))).toBe(true);
    const types = runner.calls.find((call) => call.args.includes("types"));
    expect(types?.args.filter((argument) => argument === "--config")).toHaveLength(2);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      workerName: "splitch-config-production",
      environmentVersion: 7,
      appliedEnvironmentVersion: 7,
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
        evaluationBaseUrl: "https://edge.example.test",
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
      evaluationBaseUrl: "https://edge.example.test",
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
      evaluationBaseUrl: "https://edge.example.test",
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
      evaluationBaseUrl: "https://edge.example.test",
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
          run: async () => ({ exitCode: 0, stdout: "wrangler 3.114.0", stderr: "" }),
        },
        io: { log: () => {}, error: () => {} },
      }),
    ).rejects.toThrow(/wrangler 3\.114\.0/);
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
        evaluationBaseUrl: "https://wrong.example.test",
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

function cloudflareInstallationFetch(): typeof fetch {
  let reads = 0;
  return async (_input, init) => {
    if ((init?.method ?? "GET") === "POST") return Response.json({ registered: true });
    reads += 1;
    if (reads === 1)
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
}

class RecordingRunner implements CliCommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[] }> = [];
  readonly secretInputs: string[] = [];

  async run(command: string, args: readonly string[], options: { cwd: string; input?: string }) {
    this.calls.push({ command, args });
    if (options.input) this.secretInputs.push(options.input);
    if (args.includes("--version")) return { exitCode: 0, stdout: "wrangler 4.126.0", stderr: "" };
    if (args.includes("deploy"))
      return {
        exitCode: 0,
        stdout: "https://splitch-config-production.customer.workers.dev",
        stderr: "",
      };
    return { exitCode: 0, stdout: "ok", stderr: "" };
  }
}

async function installFakeAppPackages(cwd: string): Promise<void> {
  await installFakeCloudflarePackage(cwd);
  await installFakeWrangler(cwd);
}

async function installFakeWrangler(
  cwd: string,
  bin: string | Record<string, string> = { wrangler: "./bin/wrangler.js" },
): Promise<void> {
  const directory = join(cwd, "node_modules", "wrangler");
  await mkdir(join(directory, "bin"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "wrangler",
      version: "4.126.0",
      bin,
      exports: { "./package.json": "./package.json" },
    }),
  );
  await writeFile(join(directory, "bin", "wrangler.js"), "");
}

async function installFakeCloudflarePackage(cwd: string): Promise<void> {
  const directory = join(cwd, "node_modules", "@splitch", "cloudflare");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "@splitch/cloudflare",
      type: "module",
      exports: { "./worker": "./worker.js" },
    }),
  );
  await writeFile(join(directory, "worker.js"), "export default {};\n");
}
