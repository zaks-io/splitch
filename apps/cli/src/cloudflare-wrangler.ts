import { spawn } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, posix, relative, sep } from "node:path";
import { cloudflareUsage } from "./cloudflare-error.js";
import { boundIntegrationConfigs } from "./cloudflare-files.js";
import type { CliCommandRunner } from "./execute-types.js";

export const systemCommandRunner: CliCommandRunner = {
  run(command, args, options) {
    return new Promise((resolveResult, reject) => {
      const child = spawn(command, [...args], { cwd: options.cwd, stdio: "pipe" });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => resolveResult({ exitCode: code ?? 1, stdout, stderr }));
      child.stdin.end(options.input);
    });
  },
};

const WRANGLER_MISSING =
  "Wrangler 4 is required; install wrangler in this App or globally, and authenticate with wrangler login";

/**
 * The App's own wrangler wins, run under the current Node binary. Resolving the
 * package beats shelling out to a package-manager `exec` shim: one code path
 * serves npm, pnpm, yarn, and bun, and no shim has to be on PATH.
 */
async function localWranglerBin(cwd: string): Promise<string | null> {
  let manifestPath: string;
  try {
    manifestPath = createRequire(join(cwd, "package.json")).resolve("wrangler/package.json");
  } catch {
    return null;
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    readonly bin?: string | Record<string, string>;
  };
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.wrangler;
  if (!entry) throw cloudflareUsage(`${manifestPath} declares no wrangler executable`);
  return join(dirname(manifestPath), entry);
}

async function runWrangler(
  runner: CliCommandRunner,
  cwd: string,
  args: readonly string[],
  input?: string,
) {
  const local = await localWranglerBin(cwd);
  if (local) return runner.run(process.execPath, [local, ...args], { cwd, input });
  try {
    return await runner.run("wrangler", args, { cwd, input });
  } catch (error) {
    // Only this branch resolves through PATH, so only here does ENOENT mean
    // "no wrangler" rather than an unreadable cwd.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw cloudflareUsage(WRANGLER_MISSING, error);
  }
}

export async function requireWrangler4(runner: CliCommandRunner, cwd: string): Promise<void> {
  const result = await runWrangler(runner, cwd, ["--version"]);
  const reported = `${result.stdout}\n${result.stderr}`.trim();
  // Piped wrangler prints a bare `4.146.0`; only a TTY gets the `wrangler 4.146.0` banner.
  const major = /(\d+)\.\d+\.\d+\s*$/.exec(result.stdout)?.[1];
  if (result.exitCode !== 0 || major !== "4")
    throw cloudflareUsage(
      `Wrangler 4 is required, but \`wrangler --version\` exited ${result.exitCode} reporting: ${reported || "(no output)"}`,
    );
  await wrangler(runner, cwd, ["whoami"]);
}

export async function wrangler(
  runner: CliCommandRunner,
  cwd: string,
  args: readonly string[],
  input?: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const result = await runWrangler(runner, cwd, args, input);
  if (result.exitCode !== 0)
    throw cloudflareUsage(`Wrangler failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result;
}

export async function wranglerSecret(
  runner: CliCommandRunner,
  cwd: string,
  configPath: string,
  name: string,
  value: string,
): Promise<void> {
  await wrangler(runner, cwd, ["secret", "put", name, "--config", configPath], `${value}\n`);
}

/**
 * No `--env`: Wrangler then keeps every environment's interface and leaves bindings that only some
 * environments declare optional on the base `Env`. Every bound integration config rides along so one
 * Environment's setup never untypes another's `SPLITCH`. POSIX paths relative to the App keep the
 * generated file identical across machines and let the returned command go in the App's types script.
 */
export async function wranglerTypes(
  runner: CliCommandRunner,
  cwd: string,
  appConfigPath: string,
): Promise<string> {
  const root = await realpath(cwd);
  const configPaths = [appConfigPath, ...(await boundIntegrationConfigs(cwd, appConfigPath))];
  const configs = await Promise.all(
    configPaths.map(async (path) =>
      relative(root, await realpath(path))
        .split(sep)
        .join(posix.sep),
    ),
  );
  const args = ["types", ...configs.flatMap((config) => ["--config", config])];
  await wrangler(runner, cwd, args);
  return ["wrangler", ...args].join(" ");
}

// Types follow the edit before the Worker delete, and a failed types run puts the binding back, so
// every rerun that removes the binding also regenerates the types.
export async function wranglerTypesOrRestore(
  runner: CliCommandRunner,
  cwd: string,
  appConfigPath: string,
  replaced: string,
): Promise<void> {
  try {
    await wranglerTypes(runner, cwd, appConfigPath);
  } catch (error) {
    await writeFile(appConfigPath, replaced);
    throw error;
  }
}
