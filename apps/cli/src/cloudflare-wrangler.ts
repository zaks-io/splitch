import { spawn } from "node:child_process";
import { cloudflareUsage } from "./cloudflare-error.js";
import type { CloudflareState } from "./cloudflare-files.js";
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

export async function requireWrangler4(runner: CliCommandRunner, cwd: string): Promise<void> {
  const result = await runner.run("pnpm", ["exec", "wrangler", "--version"], { cwd });
  const major = /wrangler\s+(\d+)\./i.exec(`${result.stdout}\n${result.stderr}`)?.[1];
  if (result.exitCode !== 0 || major !== "4")
    throw cloudflareUsage(
      "Wrangler 4 is required; install it in this project and authenticate with wrangler login",
    );
  await wrangler(runner, cwd, ["whoami"]);
}

export async function wrangler(
  runner: CliCommandRunner,
  cwd: string,
  args: readonly string[],
  input?: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const result = await runner.run("pnpm", ["exec", "wrangler", ...args], { cwd, input });
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

export async function wranglerTypes(
  runner: CliCommandRunner,
  cwd: string,
  state: Pick<CloudflareState, "appConfigPath" | "appBindingPath">,
  integrationConfigPath: string,
): Promise<void> {
  const args = ["types", "--config", state.appConfigPath, "--config", integrationConfigPath];
  if (state.appBindingPath[0] === "env" && state.appBindingPath[1])
    args.push("--env", state.appBindingPath[1]);
  await wrangler(runner, cwd, args);
}
