import type { CliCommandDefinition } from "./command-registry.js";
import { requiredPositionals } from "./command-positionals.js";
import { bodyJsonExampleFlag } from "./help-body-json.js";

export function commandExample(command: CliCommandDefinition): string {
  const simpleExample = simpleCommandExample(command);
  if (simpleExample) return simpleExample;
  if (command.kind === "flags_verify")
    return "splitch flags verify checkout --targeting-key user-123 --json";
  const parts = [
    "splitch",
    ...command.path,
    ...requiredPositionals(command).map((name) => `<${name}>`),
  ];
  if (command.operationId === "flags_test_eval") parts.push("--targeting-key", "user-123");
  else {
    const bodyExample = bodyJsonExampleFlag(command);
    if (bodyExample) parts.push("--body-json", `'${bodyExample}'`);
  }
  parts.push("--json");
  return parts.join(" ");
}

function simpleCommandExample(command: CliCommandDefinition): string | undefined {
  switch (command.path.join(" ")) {
    case "orgs create":
      return 'splitch orgs create --name "My Org" --json';
    case "apps list":
      return "splitch apps list --org <organization> --json";
    case "apps create":
      return 'splitch apps create --org <organization> --name "My App" --json';
    case "apps update":
      return 'splitch apps update --name "Checkout" --json';
    case "envs create":
      return 'splitch envs create --key staging --name "Staging" --json';
    case "envs update":
      return 'splitch envs update --name "Production" --json';
    case "flags create":
      return "splitch flags create --key checkout --variants on,off --json";
    case "flags update":
      return 'splitch flags update <flag-id-or-key> --name "Checkout" --json';
    case "flag-config update":
      return "splitch flag-config update <flag-id-or-key> --enabled true --rollout 100 --json";
    default:
      return undefined;
  }
}
