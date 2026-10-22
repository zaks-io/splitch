import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolveViteCloudflareWebAnalyticsToken } from "../../scripts/lib/vite-cloudflare-web-analytics-config";
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

export default defineConfig(({ mode }) => {
  const platformTarget =
    process.env.VITE_SPLITCH_PLATFORM_TARGET ??
    process.env.SPLITCH_PLATFORM_TARGET ??
    cloudflareEnvironment ??
    wranglerConfig.vars.SPLITCH_PLATFORM_TARGET ??
    mode;

  return {
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
      // `pnpm dev` starts every dev server at once; probing for 9229 races.
      cloudflare({
        inspectorPort: 0,
        viteEnvironment: { name: "ssr" },
        // Prerender through Start directly, before the homepage asset exists.
        experimental: {
          prerenderWorker: {
            config: {
              name: "splitch-marketing-prerender",
              main: fileURLToPath(import.meta.resolve("@tanstack/react-start/server-entry")),
            },
            viteEnvironment: { name: "prerender" },
          },
        },
      }),
      tanstackStart({
        prerender: {
          enabled: true,
          concurrency: 2,
          autoStaticPathsDiscovery: false,
          crawlLinks: false,
          failOnError: true,
        },
        pages: [
          { path: "/", prerender: { enabled: true, outputPath: "/index.html" } },
          { path: "/robots.txt", prerender: { enabled: true, outputPath: "/robots.txt" } },
          { path: "/sitemap.xml", prerender: { enabled: true, outputPath: "/sitemap.xml" } },
        ],
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
      "import.meta.env.VITE_SPLITCH_PLATFORM_TARGET": JSON.stringify(platformTarget),
      "import.meta.env.VITE_CLOUDFLARE_WEB_ANALYTICS_TOKEN": JSON.stringify(
        resolveViteCloudflareWebAnalyticsToken(platformTarget),
      ),
    },
  };
});
