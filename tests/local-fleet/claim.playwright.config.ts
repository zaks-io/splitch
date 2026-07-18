import { defineConfig } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: testRoot,
  testMatch: "claim.spec.ts",
  timeout: 60_000,
  use: {
    baseURL: process.env.SPLITCH_LOCAL_FLEET_CONTROL_PANEL_ORIGIN ?? "http://127.0.0.1:8793",
    trace: "retain-on-failure",
  },
  outputDir: resolve(testRoot, "../../test-results/local-fleet-claim"),
});
