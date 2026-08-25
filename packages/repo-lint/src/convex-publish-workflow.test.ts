import { registerPublishWorkflowContract } from "./publish-workflow-contract.js";

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/convex-publish.yml"), "utf8");

registerPublishWorkflowContract({
  targetKey: "convex",
  label: "CONVEX",
  packageName: "@splitch/convex",
  packageDir: "packages/convex",
  workflowName: "convex-publish.yml",
});

it("binds npm trusted publishing to the production environment", () => {
  const publishJob =
    workflow.match(/\n {2}publish:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:\n|$)/)?.[1] ?? "";

  expect(publishJob).toContain("environment: production");
});
