import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registerPublishWorkflowContract } from "./publish-workflow-contract";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workflow = readFileSync(
  path.join(repoRoot, ".github/workflows/cloudflare-publish.yml"),
  "utf8",
);

registerPublishWorkflowContract({
  targetKey: "cloudflare",
  label: "CLOUDFLARE",
  packageName: "@splitch/cloudflare",
  packageDir: "packages/cloudflare",
  workflowName: "cloudflare-publish.yml",
});

describe("cloudflare-publish token permissions", () => {
  it("grants OIDC only to the npm publish job", () => {
    const workflowPermissions = workflow.split("jobs:")[0] ?? "";
    const publishJob = workflow.split("  publish:")[1]?.split("  linear-release:")[0] ?? "";
    const linearJob = workflow.split("  linear-release:")[1] ?? "";

    expect(workflowPermissions).toContain("contents: read");
    expect(workflowPermissions).not.toContain("id-token: write");
    expect(publishJob).toContain("id-token: write");
    expect(linearJob).not.toContain("id-token: write");
  });
});
