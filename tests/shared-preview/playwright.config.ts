import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const testRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testRoot, "../..");
const isCi = process.env.CI === "true";

export default defineConfig({
  testDir: testRoot,
  testMatch: "*.spec.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: isCi ? 2 : 0,
  workers: 1,
  outputDir: resolve(repoRoot, "test-results/shared-preview"),
  reporter: isCi
    ? [
        ["github"],
        ["json", { outputFile: resolve(repoRoot, "test-results/shared-preview/results.json") }],
        [
          "html",
          { outputFolder: resolve(repoRoot, "playwright-report/shared-preview"), open: "never" },
        ],
      ]
    : [
        ["list"],
        [
          "html",
          { outputFolder: resolve(repoRoot, "playwright-report/shared-preview"), open: "never" },
        ],
      ],
  use: {
    extraHTTPHeaders: {
      "user-agent": `splitch-shared-preview-smoke/${process.env.GITHUB_RUN_ID ?? "local"}`,
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  // Split so the API smoke keeps running with no browser installed. Only the panel
  // project needs Chromium, and only its workflow step pays for installing it.
  projects: [
    { name: "api", testIgnore: "panel-*.spec.ts" },
    {
      name: "panel",
      testMatch: "panel-*.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
