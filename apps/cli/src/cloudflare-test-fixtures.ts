import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CloudflareState } from "./cloudflare-files";
import type { CliCommandRunner } from "./execute-types";

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
      exports: { "./worker": "./worker.js" },
    }),
  );
  await writeFile(join(directory, "worker.js"), "export default {};\n");
}
