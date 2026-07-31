import { registerReleaseWorkflowContract } from "./release-workflow-contract.js";

registerReleaseWorkflowContract({
  targetKey: "cli",
  label: "CLI",
  packageName: "@splitch/cli",
  packageDir: "apps/cli",
  tagPrefix: "cli-v",
  workflowName: "cli-release.yml",
});
