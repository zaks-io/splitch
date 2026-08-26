import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registerReleaseWorkflowContract } from "./release-workflow-contract";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workflow = readFileSync(
  path.join(repoRoot, ".github/workflows/cloudflare-release.yml"),
  "utf8",
);

registerReleaseWorkflowContract({
  targetKey: "cloudflare",
  label: "CLOUDFLARE",
  packageName: "@splitch/cloudflare",
  packageDir: "packages/cloudflare",
  tagPrefix: "cloudflare-v",
  workflowName: "cloudflare-release.yml",
});

describe("cloudflare-release authority", () => {
  it("rejects every ref except the repository default branch before validation", () => {
    const authorize = workflow.split("  authorize:")[1]?.split("  validate:")[0] ?? "";
    const workflowPermissions = workflow.split("jobs:")[0] ?? "";

    expect(workflowPermissions).toContain("contents: read");
    expect(workflowPermissions).not.toContain("contents: write");
    expect(authorize).toContain("github.event.repository.default_branch");
    expect(authorize).toContain("github.ref_protected");
    expect(authorize).toContain('expected_ref="refs/heads/$DEFAULT_BRANCH"');
    expect(authorize).toContain('[ "$RELEASE_REF_PROTECTED" != "true" ]');
    expect(workflow).toMatch(/ {2}validate:\n[\s\S]*? {4}needs: authorize/);
  });
});
