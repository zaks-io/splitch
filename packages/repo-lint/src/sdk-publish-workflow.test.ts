import { registerPublishWorkflowContract } from "./publish-workflow-contract.js";

registerPublishWorkflowContract({
  targetKey: "sdk",
  label: "SDK",
  packageName: "@splitch/sdk",
  packageDir: "packages/sdk",
  workflowName: "sdk-publish.yml",
});
