import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

const repoRoot = resolve(import.meta.dirname, "../..");
const runId = process.env.SPLITCH_LOCAL_E2E_RUN_ID ?? randomUUID();
process.env.SPLITCH_LOCAL_E2E_RUN_ID = runId;

export default defineConfig({
  metadata: { localE2eRunId: runId },
  testDir: resolve(repoRoot, "e2e/control-panel"),
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  // SPL-181: the fault reporter runs in every mode so a miniflare D1 crash is
  // named as a harness fault instead of being mis-read as a product failure.
  reporter: [
    ["line"],
    ...(process.env.CI ? [["html", { open: "never" }] as const] : []),
    [resolve(repoRoot, "scripts/local-e2e-fault-reporter.mjs")],
  ],
  outputDir: resolve(repoRoot, "test-results/control-panel-e2e"),
  use: {
    baseURL: "http://127.0.0.1:18793",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node scripts/local-e2e-fleet.mjs ${runId}`,
    cwd: repoRoot,
    url: `http://127.0.0.1:18799/health?run=${runId}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
