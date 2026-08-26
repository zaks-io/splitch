import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          SPLITCH_API_KEY: "test-api-key",
          SPLITCH_PUSH_SECRET: "test-push-secret",
        },
      },
    }),
  ],
});
