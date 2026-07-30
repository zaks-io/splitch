import { registerPublishWorkflowContract } from "./publish-workflow-contract.js";

registerPublishWorkflowContract({
  targetKey: "cli",
  label: "CLI",
  packageName: "@splitch/cli",
  packageDir: "apps/cli",
  tag: "cli-v0.1.0",
  workflowName: "cli-publish.yml",
});
