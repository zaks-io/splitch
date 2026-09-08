import { registerReleaseWorkflowContract } from "./release-workflow-contract";

registerReleaseWorkflowContract({
  targetKey: "cloudflare",
  label: "CLOUDFLARE",
  packageName: "@splitch/cloudflare",
  packageDir: "packages/cloudflare",
  tagPrefix: "cloudflare-v",
  workflowName: "cloudflare-release.yml",
});
