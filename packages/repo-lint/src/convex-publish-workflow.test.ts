import { registerPublishWorkflowContract } from "./publish-workflow-contract.js";

registerPublishWorkflowContract({
  targetKey: "convex",
  label: "CONVEX",
  packageName: "@splitch/convex",
  packageDir: "packages/convex",
  workflowName: "convex-publish.yml",
});
