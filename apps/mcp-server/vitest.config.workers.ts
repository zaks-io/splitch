import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        serviceBindings: {
          CONTROL_PLANE_API: controlPlaneService,
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

function controlPlaneService(request: Request): Response {
  const path = new URL(request.url).pathname;
  if (path === "/apps/app_session") {
    return Response.json({
      id: "app_session",
      organizationId: "org_session",
      name: "Session App",
      key: "session-app",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
  }
  if (path === "/apps/app_session/envs/env_session") {
    return Response.json({
      id: "env_session",
      appId: "app_session",
      key: "session",
      name: "Session",
      policy: {
        variantAvailability: "allow",
        targetingRolloutValue: "allow",
        enabledState: "allow",
        startExperimentRun: "allow",
      },
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
  }
  return new Response("Service binding unavailable in this test pool", { status: 503 });
}
