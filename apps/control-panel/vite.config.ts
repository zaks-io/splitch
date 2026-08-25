import { resolve } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import {
  readViteWorkerConfig,
  resolveViteSentryRelease,
} from "../../scripts/lib/vite-worker-sentry-config";

const wranglerConfig = readViteWorkerConfig(
  resolve(import.meta.dirname, "wrangler.jsonc"),
  "splitch-control-panel",
);
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
        resolveViteSentryRelease(wranglerConfig.name),
    ),
    "import.meta.env.VITE_SPLITCH_PLATFORM_TARGET": JSON.stringify(
      process.env.VITE_SPLITCH_PLATFORM_TARGET ??
        process.env.SPLITCH_PLATFORM_TARGET ??
        cloudflareEnvironment ??
        wranglerConfig.vars.SPLITCH_PLATFORM_TARGET ??
        mode,
    ),
  },
}));
