import { defineTestFileManifest } from "../../scripts/vitest-test-manifest";

export const D1_TEST_FILES = defineTestFileManifest(import.meta.url, [
  "src/app-identity-reset-runtime.test.ts",
  "src/attention-rollup-fanout.test.ts",
  "src/attention-rollup-isolation.test.ts",
  "src/attention-rollup-plan-guard.test.ts",
  "src/attention-rollup.test.ts",
  "src/panel-overview-access.test.ts",
  "src/panel-overview-experiment-bounds.test.ts",
  "src/panel-overview-flag-bounds.test.ts",
  "src/panel-overview.test.ts",
]);
