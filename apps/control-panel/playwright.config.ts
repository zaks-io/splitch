import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

const repoRoot = resolve(import.meta.dirname, "../..");

export default defineConfig({
  testDir: resolve(repoRoot, "e2e/control-panel"),
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  outputDir: resolve(repoRoot, "test-results/control-panel-e2e"),
  use: {
    baseURL: "http://127.0.0.1:18793",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/local-e2e-fleet.mjs",
    cwd: repoRoot,
    url: "http://127.0.0.1:18799/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
