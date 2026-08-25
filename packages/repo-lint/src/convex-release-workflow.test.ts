import { registerReleaseWorkflowContract } from "./release-workflow-contract.js";

registerReleaseWorkflowContract({
  targetKey: "convex",
  label: "CONVEX",
  packageName: "@splitch/convex",
  packageDir: "packages/convex",
  workflowName: "convex-release.yml",
  tagPrefix: "convex-v",
});
