import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        serviceBindings: {
          CONTROL_PLANE_API: unavailableService,
          EVALUATION_API: unavailableService,
          ANALYSIS_API: unavailableService,
        },
      },
    }),
  ],
  resolve: {
    alias: {
      "@splitch/contracts": new URL("../../packages/contracts/src/index.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    include: ["test/**/*.{test,spec}.ts"],
    passWithNoTests: true,
  },
});

function unavailableService(): Response {
  return new Response("Service binding unavailable in this test pool", { status: 503 });
}
