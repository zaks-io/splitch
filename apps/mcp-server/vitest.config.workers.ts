import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        serviceBindings: {
          CONTROL_PLANE_API: unavailableService,
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
    name: "workers",
    include: ["test/**/*.{test,spec}.ts"],
    passWithNoTests: true,
    // Miniflare startup plus CPU contention from the parallel verify graph
    // makes the 5s default flaky (SPL-231).
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});

function unavailableService(): Response {
  return new Response("Service binding unavailable in this test pool", { status: 503 });
}
