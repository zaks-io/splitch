import { deriveMcpTools, getRoute, type McpToolDefinition } from "@splitch/contracts";

const RESOURCE_ALIASES: Record<string, string> = {
  organizations: "orgs",
  environments: "envs",
};

const COMPOUND_VERBS = ["test_eval"] as const;

export interface CliCommandDefinition {
  /** Stable operation identity (MCP tool name for API commands). */
  readonly operationId: string;
  /** Human CLI path segments, e.g. ["flags", "list"]. */
  readonly path: readonly string[];
  readonly needsApp: boolean;
  readonly needsEnvironment: boolean;
  readonly supportsConfirm: boolean;
  readonly kind: "api" | "flags_verify" | "env_policy_get" | "env_policy_set";
}

function resourceToCliGroup(resource: string): string {
  const parts = resource.split("_");
  const aliased = parts.map((part) => RESOURCE_ALIASES[part] ?? part);
  return aliased.join("-");
}

function operationIdToPath(operationId: string): readonly string[] {
  for (const verb of COMPOUND_VERBS) {
    const suffix = `_${verb}`;
    if (operationId.endsWith(suffix)) {
      const resource = operationId.slice(0, -suffix.length);
      return [resourceToCliGroup(resource), verb.replaceAll("_", "-")];
    }
  }
  const lastUnderscore = operationId.lastIndexOf("_");
  const resource = operationId.slice(0, lastUnderscore);
  const verb = operationId.slice(lastUnderscore + 1);
  return [resourceToCliGroup(resource), verb];
}

function needsAppFromPath(path: string): boolean {
  return path.includes(":appId");
}

function needsEnvironmentFromPath(path: string): boolean {
  return path.includes(":environmentId") || path.includes(":targetEnvironmentId");
}

function supportsConfirm(operationId: string): boolean {
  return (
    operationId === "flags_promote" ||
    operationId === "flag_config_update" ||
    operationId === "flag_targeting_rules_replace" ||
    operationId === "flag_variants_update" ||
    operationId === "experiments_start"
  );
}

function buildApiCommands(): CliCommandDefinition[] {
  return deriveMcpTools().map((tool: McpToolDefinition) => ({
    operationId: tool.name,
    path: operationIdToPath(tool.name),
    needsApp: needsAppFromPath(getRoutePath(tool.name)),
    needsEnvironment: needsEnvironmentFromPath(getRoutePath(tool.name)),
    supportsConfirm: supportsConfirm(tool.name),
    kind: "api",
  }));
}

function getRoutePath(operationId: string): string {
  return getRoute(operationId)?.path ?? "";
}

const API_COMMANDS = buildApiCommands();

const PRESENTATION_ALIASES: readonly CliCommandDefinition[] = [
  {
    operationId: "environments_get",
    path: ["env-policy", "get"],
    needsApp: true,
    needsEnvironment: true,
    supportsConfirm: false,
    kind: "env_policy_get",
  },
  {
    operationId: "environments_update",
    path: ["env-policy", "set"],
    needsApp: true,
    needsEnvironment: true,
    supportsConfirm: false,
    kind: "env_policy_set",
  },
  {
    operationId: "sdk_verify",
    path: ["flags", "verify"],
    needsApp: true,
    needsEnvironment: true,
    supportsConfirm: false,
    kind: "flags_verify",
  },
];

export const CLI_COMMANDS: readonly CliCommandDefinition[] = [
  ...API_COMMANDS,
  ...PRESENTATION_ALIASES,
];

export const META_COMMANDS = ["login", "logout", "use", "context", "health"] as const;

export function findCommand(path: readonly string[]): CliCommandDefinition | undefined {
  const key = path.join("\0");
  return COMMAND_LOOKUP.get(key);
}

const COMMAND_LOOKUP = new Map<string, CliCommandDefinition>(
  CLI_COMMANDS.map((command) => [command.path.join("\0"), command]),
);

export function allMcpParityOperationIds(): readonly string[] {
  return deriveMcpTools().map((tool: McpToolDefinition) => tool.name);
}
