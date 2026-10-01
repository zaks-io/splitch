import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CloudflareState, generatedPaths, readState } from "./cloudflare-files";
import type { CredentialStore } from "./credentials";
import { executeInvocation } from "./execute";
import type { CliCommandRunner, CliResult } from "./execute-types";
import { parseInvocation } from "./parse-args";

export function cloudflareState(cwd: string): CloudflareState {
  return {
    version: 1,
    environment: "production",
    workerName: "splitch-config-production",
    installationId: "00000000-0000-4000-8000-000000000000",
    pushSecret: "p".repeat(43),
    endpoint:
      "https://splitch-config-production.example.workers.dev/integrations/splitch/configuration",
    appConfigPath: join(cwd, "wrangler.jsonc"),
    appBindingPath: ["services"],
  };
}

export const INSTALLATION_STATUS = {
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
};

export function cloudflareInstallationFetch(): typeof fetch {
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
    return Response.json(INSTALLATION_STATUS);
  };
}

export class RecordingRunner implements CliCommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[] }> = [];
  readonly secretInputs: string[] = [];

  async run(command: string, args: readonly string[], options: { cwd: string; input?: string }) {
    this.calls.push({ command, args });
    if (options.input) this.secretInputs.push(options.input);
    if (args.includes("--version")) return { exitCode: 0, stdout: "4.126.0\n", stderr: "" };
    if (args.includes("deploy"))
      return {
        exitCode: 0,
        stdout: "https://splitch-config-production.customer.workers.dev",
        stderr: "",
      };
    return { exitCode: 0, stdout: "ok", stderr: "" };
  }
}

export async function installFakeAppPackages(cwd: string): Promise<void> {
  await installFakeCloudflarePackage(cwd);
  await installFakeWrangler(cwd);
}

export async function installFakeWrangler(
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

export async function installFakeCloudflarePackage(cwd: string): Promise<void> {
  const directory = join(cwd, "node_modules", "@splitch", "cloudflare");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "@splitch/cloudflare",
      type: "module",
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./worker": { types: "./dist/worker.d.ts", import: "./dist/worker.js" },
      },
    }),
  );
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, "dist", "worker.js"), "export default {};\n");
}

export const WRANGLER_ENVIRONMENTS_CONFIG = {
  name: "customer-app",
  env: { preview: {}, production: {} },
};

export async function appWithConfig(config: object): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "splitch-cloudflare-wrangler-env-"));
  await installFakeAppPackages(cwd);
  await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify(config));
  return cwd;
}

export function setupCloudflare(cwd: string, runner: RecordingRunner, flags: readonly string[]) {
  return runCloudflare(cwd, runner, ["cloudflare", "setup", ...flags, "--json"], {
    fetch: cloudflareInstallationFetch(),
  });
}

// Cloudflare commands authenticate with SPLITCH_API_KEY and never read stored credentials.
const UNUSED_CREDENTIAL_STORE: CredentialStore = {
  load: () => Promise.reject(new Error("Cloudflare commands must not read stored credentials")),
  save: () => Promise.reject(new Error("Cloudflare commands must not write stored credentials")),
  clear: () => Promise.reject(new Error("Cloudflare commands must not clear stored credentials")),
};

export function runCloudflare(
  cwd: string,
  runner: RecordingRunner,
  args: readonly string[],
  options: { readonly fetch: typeof fetch },
): Promise<CliResult> {
  return executeInvocation(parseInvocation(args), {
    cwd,
    env: { SPLITCH_API_KEY: "api-key" },
    credentialStore: UNUSED_CREDENTIAL_STORE,
    platformTarget: "local",
    evaluationBaseUrl: "http://127.0.0.1:8788",
    fetch: options.fetch,
    commandRunner: runner,
    sleep: async () => {},
    io: { log: () => {}, error: () => {} },
  });
}

export async function appConfig(cwd: string) {
  return JSON.parse(await readFile(join(cwd, "wrangler.jsonc"), "utf8"));
}

export async function recordedState(cwd: string, environment: string): Promise<CloudflareState> {
  const recorded = await readState(generatedPaths(cwd, environment).statePath);
  if (!recorded) throw new Error(`No Cloudflare state for ${environment}`);
  return recorded;
}

export function wranglerTypesEnv(runner: RecordingRunner): string | undefined {
  const args = runner.calls.find((call) => call.args.includes("types"))?.args ?? [];
  const index = args.indexOf("--env");
  return index === -1 ? undefined : args[index + 1];
}
