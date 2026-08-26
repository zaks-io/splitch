import { defineConfig } from "tsup";

/**
 * The Sentry reporter, built separately so `@sentry/core` stays external. The
 * base config bundles everything (`external: []`) to keep the SDK dependency
 * free; inlining Sentry here would ship a second copy of it into apps that
 * already have one, and the two copies would not share a client.
 */
export default defineConfig({
  entry: { "sentry/index": "src/sentry/index.ts" },
  outDir: "dist",
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  dts: true,
  bundle: true,
  splitting: false,
  clean: false,
  sourcemap: false,
  external: ["@sentry/core"],
});
