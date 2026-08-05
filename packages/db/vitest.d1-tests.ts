import { defineTestFileManifest } from "../../scripts/vitest-test-manifest";

export const D1_TEST_FILES = defineTestFileManifest(import.meta.url, [
  "src/repo/app-delete-cascade-isolation.test.ts",
  "src/repo/app-delete-cascade.test.ts",
  "src/repo/approval-decline-reviewer-role.test.ts",
  "src/repo/approval-disposition-isolation.test.ts",
  "src/repo/approval-variant-version-race.test.ts",
  "src/repo/claim-retention.test.ts",
  "src/repo/experiment-start-approval-landing.test.ts",
  "src/repo/flag-key-uniqueness.test.ts",
  "src/repo/flag-variant-run-freeze.test.ts",
  "src/repo/id-batches.test.ts",
  "src/repo/identity-demo-reaper.test.ts",
  "src/repo/identity-session-reads.test.ts",
  "src/repo/isolation.test.ts",
  "src/repo/scope-tamper.test.ts",
  "src/repo/test-d1-pool.test.ts",
  "src/repo/type-safety.test.ts",
  "src/repo/variant-rename-run-freeze.test.ts",
  "src/repo/write-isolation.test.ts",
  "src/schema-runtime.test.ts",
]);
