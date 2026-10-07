import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        mode: "sentry-v11",
        test: {
          name: "sdk-sentry-v11",
          include: ["src/**/*.{test,spec}.ts"],
          passWithNoTests: true,
        },
      },
      {
        mode: "sentry-v10",
        resolve: {
          alias: { "@sentry/core": fileURLToPath(import.meta.resolve("@sentry/core-v10")) },
        },
        test: { name: "sentry-v10", include: ["src/sentry/index.test.ts"] },
      },
    ],
  },
});
