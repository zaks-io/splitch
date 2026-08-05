import type { CliCommandDefinition } from "./command-registry.js";

export interface DeleteModeHelpFlag {
  readonly syntax: string;
  readonly type: string;
  readonly defaultValue: string;
  readonly description: string;
}

function flag(
  syntax: string,
  type: string,
  defaultValue: string,
  description: string,
): DeleteModeHelpFlag {
  return { syntax, type, defaultValue, description };
}

/** `--dry-run` / `--force` for App teardown (SPL-326). */
export function deleteModeHelpFlags(command: CliCommandDefinition): DeleteModeHelpFlag[] {
  if (command.operationId !== "apps_delete") return [];
  return [
    flag(
      "--dry-run",
      "boolean",
      "false",
      "List every delete blocker with IDs and remove commands; delete nothing.",
    ),
    flag(
      "--force",
      "boolean",
      "false",
      "Cascade non-gated children in dependency order; stop with pending Approval Request IDs when Policy requires Review.",
    ),
  ];
}
