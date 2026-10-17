import type { HelpFlag } from "./help-flags.js";

export function environmentHelpFlags(operationId: string): HelpFlag[] {
  switch (operationId) {
    case "environments_create":
      return [
        flag("--temporary", "boolean", "false", "Create a Temporary Environment from --from."),
        flag(
          "--from <environment>",
          "string",
          "none",
          "Source Environment ID or key; requires --temporary.",
        ),
        flag(
          "--expires-at <instant|days>",
          "ISO 8601 with offset | day count",
          "7d",
          "Temporary Environment expiry, more than one minute and at most seven days out, for example 3d.",
        ),
      ];
    case "environments_sync":
      return [
        flag(
          "--from <environment>",
          "string",
          "required",
          "Source Environment ID or key to Sync from.",
        ),
      ];
    default:
      return [];
  }
}

function flag(syntax: string, type: string, defaultValue: string, description: string): HelpFlag {
  return { syntax, type, defaultValue, description };
}
