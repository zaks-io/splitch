import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { parseConfigFileTextToJson } from "typescript";
import { defineConfig } from "vite";

const wranglerConfig = readWranglerConfig();
const localE2eRunId = process.env.SPLITCH_LOCAL_E2E_RUN_ID;
const cloudflareEnvironment =
  process.env.CLOUDFLARE_ENV ?? process.env.SPLITCH_GENERATED_WRANGLER_ENV;
const isHostedWorkerBuild =
  cloudflareEnvironment === "production" || cloudflareEnvironment === "shared-preview";

export default defineConfig(({ mode }) => ({
  server: {
    host: "127.0.0.1",
    port: 8793,
  },
  preview: {
    host: "127.0.0.1",
    port: 8793,
  },
  plugins: [
    tailwindcss(),
    cloudflare({
      config:
        localE2eRunId || isHostedWorkerBuild
          ? (config) => {
              if (isHostedWorkerBuild) {
                // The deploy wrapper uploads these runtime values from the source config.
                // Cacheable hosted builds must never require or capture their values.
                delete config.secrets;
              }
              if (localE2eRunId) {
                return {
                  vars: {
                    ...config.vars,
                    SENTRY_DSN: "",
                    SPLITCH_LOCAL_E2E_RUN_ID: localE2eRunId,
                  },
                };
              }
              return undefined;
            }
          : undefined,
      persistState: process.env.SPLITCH_LOCAL_E2E_PERSIST_PATH
        ? { path: process.env.SPLITCH_LOCAL_E2E_PERSIST_PATH }
        : true,
      viteEnvironment: { name: "ssr" },
    }),
    tanstackStart(),
    react(),
  ],
  define: {
    "import.meta.env.VITE_SENTRY_DSN": JSON.stringify(
      process.env.VITE_SENTRY_DSN ?? wranglerConfig.vars.SENTRY_DSN ?? "",
    ),
    "import.meta.env.VITE_SENTRY_RELEASE": JSON.stringify(
      process.env.VITE_SENTRY_RELEASE ??
        process.env.SENTRY_RELEASE ??
        resolveClientSentryRelease(wranglerConfig.name),
    ),
    "import.meta.env.VITE_SPLITCH_PLATFORM_TARGET": JSON.stringify(
      process.env.VITE_SPLITCH_PLATFORM_TARGET ??
        process.env.SPLITCH_PLATFORM_TARGET ??
        wranglerConfig.vars.SPLITCH_PLATFORM_TARGET ??
        mode,
    ),
  },
}));

type WranglerConfig = {
  name: string;
  vars: Record<string, string>;
};

function readWranglerConfig(): WranglerConfig {
  const configPath = resolve(import.meta.dirname, "wrangler.jsonc");
  const parsed = parseConfigFileTextToJson(configPath, readFileSync(configPath, "utf8"));
  if (parsed.error || typeof parsed.config !== "object" || parsed.config === null) {
    return { name: "splitch-control-panel", vars: {} };
  }
  const name = (parsed.config as { name?: unknown }).name;
  const vars = (parsed.config as { vars?: unknown }).vars;
  if (typeof vars !== "object" || vars === null) {
    return { name: typeof name === "string" ? name : "splitch-control-panel", vars: {} };
  }
  return {
    name: typeof name === "string" ? name : "splitch-control-panel",
    vars: Object.fromEntries(
      Object.entries(vars).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  };
}

function resolveClientSentryRelease(workerName: string): string {
  const baseRelease =
    process.env.SENTRY_RELEASE_BASE ?? commandOutput("git", ["rev-parse", "HEAD"]);
  return baseRelease ? `${workerName}@${baseRelease}` : "";
}

function commandOutput(command: string, commandArgs: string[]): string | undefined {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.trim() || undefined;
}
