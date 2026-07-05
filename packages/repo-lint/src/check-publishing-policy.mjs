#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { lintPublishingPolicyFromRepo } from "./policy/run.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const violations = await lintPublishingPolicyFromRepo(repoRoot);

if (violations.length === 0) {
  console.log("repo-lint publishing policy passed");
  process.exit(0);
}

console.error("repo-lint publishing policy failed");
for (const { packagePath, message } of violations) {
  console.error(`${packagePath}: ${message}`);
}
process.exit(1);
