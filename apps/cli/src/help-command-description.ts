import { deriveMcpTools } from "@splitch/contracts";
import type { CliCommandDefinition } from "./command-registry.js";

export const toolByOperation = new Map(deriveMcpTools().map((tool) => [tool.name, tool]));

export function commandDescription(command: CliCommandDefinition): string {
  if (command.kind === "cloudflare_setup")
    return "Deploy and bind a durable local-evaluation Worker for the selected Environment.";
  if (command.kind === "cloudflare_status")
    return "Read Cloudflare configuration delivery and local Worker status.";
  if (command.kind === "cloudflare_remove")
    return "Revoke configuration delivery, unbind the service, and delete the integration Worker.";
  if (command.kind === "flags_verify") {
    return "Verify a Flag KEY through the data plane without firing an Exposure.";
  }
  if (command.kind === "env_policy_get") return "Get the selected Environment Policy.";
  if (command.kind === "env_policy_set") return "Update the selected Environment Policy.";
  return toolByOperation.get(command.operationId)?.description ?? `Run ${command.operationId}.`;
}
