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
  "splitch-marketing",
);
const cloudflareEnvironment =
  process.env.CLOUDFLARE_ENV ?? process.env.SPLITCH_GENERATED_WRANGLER_ENV;

export default defineConfig(({ mode }) => ({
  server: {
    host: "127.0.0.1",
    port: 8794,
  },
  preview: {
    host: "127.0.0.1",
    port: 8794,
  },
  plugins: [
    tailwindcss(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({
      prerender: {
        enabled: true,
        autoStaticPathsDiscovery: false,
        crawlLinks: false,
        failOnError: true,
      },
      pages: [{ path: "/", prerender: { enabled: true, outputPath: "/index.html" } }],
    }),
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
