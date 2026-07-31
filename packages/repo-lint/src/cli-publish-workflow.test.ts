import { registerPublishWorkflowContract } from "./publish-workflow-contract.js";

registerPublishWorkflowContract({
  targetKey: "cli",
  label: "CLI",
  packageName: "@splitch/cli",
  packageDir: "apps/cli",
  workflowName: "cli-publish.yml",
});
