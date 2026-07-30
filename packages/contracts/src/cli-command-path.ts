/**
 * The CLI skin's naming rule (ADR-0023: one route registry, many skins).
 *
 * An `operationId` is the single identity of an operation; the MCP tool name IS
 * that id, and the CLI command path is derived from it here. This lives in
 * contracts rather than in the CLI because the Control Panel also has to print
 * the CLI equivalent of what a screen does, and a second copy of this rule would
 * let the panel teach a command the CLI does not answer to.
 */

const RESOURCE_ALIASES: Record<string, string> = {
  organizations: "orgs",
  environments: "envs",
};

const COMPOUND_VERBS = ["test_eval"] as const;

function resourceToCliGroup(resource: string): string {
  return resource
    .split("_")
    .map((part) => RESOURCE_ALIASES[part] ?? part)
    .join("-");
}

/** `flags_create` -> `["flags", "create"]`; `flags_test_eval` -> `["flags", "test-eval"]`. */
export function cliCommandPath(operationId: string): readonly string[] {
  for (const verb of COMPOUND_VERBS) {
    const suffix = `_${verb}`;
    if (operationId.endsWith(suffix)) {
      return [resourceToCliGroup(operationId.slice(0, -suffix.length)), verb.replaceAll("_", "-")];
    }
  }
  const lastUnderscore = operationId.lastIndexOf("_");
  return [
    resourceToCliGroup(operationId.slice(0, lastUnderscore)),
    operationId.slice(lastUnderscore + 1),
  ];
}

/**
 * Command paths the CLI registers IN ADDITION to the derived one, because the
 * derived name reads badly for humans (`splitch sdk verify` vs `splitch flags
 * verify`). The CLI builds its alias commands from this map and the panel
 * prints from it, so the alias has one definition and the two cannot diverge.
 */
export const CLI_PRESENTATION_ALIAS_PATHS = {
  environments_get: ["env-policy", "get"],
  environments_update: ["env-policy", "set"],
  sdk_verify: ["flags", "verify"],
} as const satisfies Record<string, readonly string[]>;

export type CliPresentationAliasOperationId = keyof typeof CLI_PRESENTATION_ALIAS_PATHS;

/** The full command as a user types it, e.g. `splitch client-key get`. */
export function cliCommandString(operationId: string): string {
  return `splitch ${cliCommandPath(operationId).join(" ")}`;
}

/** The full aliased command as a user types it, e.g. `splitch flags verify`. */
export function cliPresentationAliasString(operationId: CliPresentationAliasOperationId): string {
  return `splitch ${CLI_PRESENTATION_ALIAS_PATHS[operationId].join(" ")}`;
}
