import { registerPublishWorkflowContract } from "./publish-workflow-contract.js";

registerPublishWorkflowContract({
  targetKey: "sdk",
  label: "SDK",
  packageName: "@splitch/sdk",
  packageDir: "packages/sdk",
  tag: "sdk-v0.1.0",
  workflowName: "sdk-publish.yml",
});
