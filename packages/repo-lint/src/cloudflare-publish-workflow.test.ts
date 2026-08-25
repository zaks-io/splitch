import { registerPublishWorkflowContract } from "./publish-workflow-contract";

registerPublishWorkflowContract({
  targetKey: "cloudflare",
  label: "CLOUDFLARE",
  packageName: "@splitch/cloudflare",
  packageDir: "packages/cloudflare",
  workflowName: "cloudflare-publish.yml",
});
