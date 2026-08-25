import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseConfigFileTextToJson } from "typescript";

export type ViteWorkerConfig = {
  name: string;
  vars: Record<string, string>;
};

export function readViteWorkerConfig(configPath: string, fallbackName: string): ViteWorkerConfig {
  const parsed = parseConfigFileTextToJson(configPath, readFileSync(configPath, "utf8"));
  if (parsed.error || typeof parsed.config !== "object" || parsed.config === null) {
    return { name: fallbackName, vars: {} };
  }
  const name = (parsed.config as { name?: unknown }).name;
  const vars = (parsed.config as { vars?: unknown }).vars;
  if (typeof vars !== "object" || vars === null) {
    return { name: typeof name === "string" ? name : fallbackName, vars: {} };
  }
  return {
    name: typeof name === "string" ? name : fallbackName,
    vars: Object.fromEntries(
      Object.entries(vars).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  };
}

export function resolveViteSentryRelease(workerName: string): string {
  const baseRelease =
    process.env.SENTRY_RELEASE_BASE ?? commandOutput("git", ["rev-parse", "HEAD"]);
  return baseRelease ? `${workerName}@${baseRelease}` : "";
}

function commandOutput(command: string, commandArgs: string[]): string | undefined {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}
