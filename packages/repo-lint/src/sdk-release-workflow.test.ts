import { registerReleaseWorkflowContract } from "./release-workflow-contract.js";

registerReleaseWorkflowContract({
  targetKey: "sdk",
  label: "SDK",
  packageName: "@splitch/sdk",
  packageDir: "packages/sdk",
  tagPrefix: "sdk-v",
  workflowName: "sdk-release.yml",
});
