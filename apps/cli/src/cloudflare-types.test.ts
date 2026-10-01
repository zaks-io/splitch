import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appConfig,
  installFakeCloudflarePackage,
  RecordingRunner,
  runCloudflare,
  setupCloudflare,
} from "./cloudflare-test-fixtures";
import { systemCommandRunner } from "./cloudflare-wrangler";

const TYPES_FILE = "worker-configuration.d.ts";
const DEV_SERVICE = 'Service<typeof import("./.splitch/cloudflare/dev/worker").default>';

// A fake runner let SPL-674 ship `--env` and absolute paths, so `types` runs the workspace's real
// Wrangler against a multi-environment App while deploy, secrets, and whoami stay recorded.
class RealTypesRunner extends RecordingRunner {
  override async run(command: string, args: readonly string[], options: { cwd: string }) {
    if (!args.includes("types")) return super.run(command, args, options);
    this.calls.push({ command, args });
    return systemCommandRunner.run(command, args, options);
  }
}

describe("cloudflare setup and remove against real wrangler types", () => {
  it("keeps every environment interface and binding optionality on a multi-environment App", async () => {
    const cwd = await multiEnvironmentApp();

    await setupDevInPreview(cwd);

    const types = await readFile(join(cwd, TYPES_FILE), "utf8");
    const header = types.split("\n").slice(0, 3).join("\n");
    expect(header).toContain(
      "wrangler types --config=wrangler.jsonc --config=.splitch/cloudflare/dev/wrangler.jsonc`",
    );
    expect(header).not.toContain(cwd);
    expect(header).not.toContain(await realpath(cwd));
    expect(types).toContain("interface PreviewEnv {");
    expect(types).toContain("interface ProductionEnv {");
    expect(baseEnv(types)).toContain("ARCHIVE?: KVNamespace;");
    expect(baseEnv(types)).toContain(`SPLITCH?: ${DEV_SERVICE};`);
  }, 60_000);

  it("leaves the types file untouched when remove finds no installed binding", async () => {
    const cwd = await multiEnvironmentApp();
    await setupDevInPreview(cwd);
    const config = await appConfig(cwd);
    config.env.preview.services = [];
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify(config));
    const before = await readFile(join(cwd, TYPES_FILE), "utf8");

    await removeDev(cwd);

    expect(await readFile(join(cwd, TYPES_FILE), "utf8")).toBe(before);
  }, 60_000);

  it("drops SPLITCH from the regenerated types once remove deletes the binding", async () => {
    const cwd = await multiEnvironmentApp();
    await setupDevInPreview(cwd);

    await removeDev(cwd);

    const types = await readFile(join(cwd, TYPES_FILE), "utf8");
    expect(types).not.toContain("SPLITCH");
    expect(types).toContain("interface PreviewEnv {");
    expect(baseEnv(types)).toContain("ARCHIVE?: KVNamespace;");
  }, 60_000);
});

async function multiEnvironmentApp(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "splitch-cloudflare-types-"));
  await installFakeCloudflarePackage(cwd);
  const wrangler = dirname(createRequire(import.meta.url).resolve("wrangler/package.json"));
  await mkdir(join(cwd, "node_modules"), { recursive: true });
  await symlink(wrangler, join(cwd, "node_modules", "wrangler"), "dir");
  await writeFile(
    join(cwd, "wrangler.jsonc"),
    JSON.stringify({
      name: "customer-app",
      compatibility_date: "2026-08-22",
      env: {
        preview: { kv_namespaces: [{ binding: "ARCHIVE", id: "archive-preview" }] },
        production: {},
      },
    }),
  );
  return cwd;
}

function setupDevInPreview(cwd: string) {
  return setupCloudflare(cwd, new RealTypesRunner(), ["--env", "dev", "--wrangler-env", "preview"]);
}

function removeDev(cwd: string) {
  return runCloudflare(cwd, new RealTypesRunner(), ["cloudflare", "remove", "--env", "dev"], {
    fetch: async () => Response.json(null),
  });
}

function baseEnv(types: string): string {
  const match = /interface __BaseEnv_Env \{[^}]*\}/.exec(types);
  if (!match) throw new Error(`No base Env interface in generated types:\n${types}`);
  return match[0];
}
