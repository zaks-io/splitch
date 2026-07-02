import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  resolve: {
    alias: {
      "@splitch/contracts": new URL("../../packages/contracts/src/index.ts", import.meta.url)
        .pathname,
      "@splitch/db": new URL("../../packages/db/src/index.ts", import.meta.url).pathname,
      "@splitch/worker-runtime": new URL(
        "../../packages/worker-runtime/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: ["test/**/*.{test,spec}.ts"],
    passWithNoTests: true,
  },
});
