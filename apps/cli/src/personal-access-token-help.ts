import type { HelpFlag } from "./help-flags.js";
import { DEFAULT_PERSONAL_ACCESS_TOKEN_ENV_VAR } from "./personal-access-token-secret.js";

/**
 * Help for `splitch tokens …`. These operations derive no MCP tool, so their
 * descriptions and flags cannot come from the tool schema the other commands
 * read; they are spelled out here instead.
 */

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  personal_access_tokens_list:
    "List your Personal Access Tokens for the MCP server: names, grants, expiry, and status. Secrets are never shown.",
  personal_access_tokens_create:
    "Create a Personal Access Token for connecting the MCP server without browser sign-in. The secret is written to --output-file and never printed.",
  personal_access_tokens_update:
    "Rename a Personal Access Token or replace its grants or expiry. Takes effect on its next use; the secret is unchanged.",
  personal_access_tokens_rotate:
    "Replace a Personal Access Token's secret. The old secret stops working; the new one is written to --output-file and never printed.",
  personal_access_tokens_revoke: "Revoke a Personal Access Token. Its next use is refused.",
  personal_access_tokens_revoke_all: "Revoke every active Personal Access Token you own.",
};

const EXAMPLES: Readonly<Record<string, string>> = {
  personal_access_tokens_list: "splitch tokens list --json",
  personal_access_tokens_create:
    "splitch tokens create --name sandboxes --grant app:app_123:admin:read-write --expires-at never --output-file ~/.config/splitch/mcp.env --append --json",
  personal_access_tokens_update:
    "splitch tokens update <token-id> --grant all:member:read --expires-at 30d --json",
  personal_access_tokens_rotate:
    "splitch tokens rotate <token-id> --output-file ~/.config/splitch/mcp.env --append --force --json",
  personal_access_tokens_revoke: "splitch tokens revoke <token-id> --json",
  personal_access_tokens_revoke_all: "splitch tokens revoke-all --json",
};

export function personalAccessTokenDescription(operationId: string): string | undefined {
  return DESCRIPTIONS[operationId];
}

export function personalAccessTokenExample(operationId: string): string | undefined {
  return EXAMPLES[operationId];
}

export function personalAccessTokenHelpFlags(operationId: string): HelpFlag[] {
  switch (operationId) {
    case "personal_access_tokens_create":
      return [
        flag(
          "--name <name>",
          "string",
          "required",
          "Label for the token, e.g. the machines it serves.",
        ),
        ...grantFlags("required"),
        ...secretFlags(),
      ];
    case "personal_access_tokens_update":
      return [
        flag("--name <name>", "string", "current value", "New label for the token."),
        ...grantFlags("current value"),
      ];
    case "personal_access_tokens_rotate":
      return secretFlags();
    default:
      return [];
  }
}

function grantFlags(defaultValue: string): HelpFlag[] {
  return [
    flag(
      "--grant <target:role:access>",
      "string (repeatable)",
      defaultValue,
      "What the token may reach. Target: all, org:<org id>, or app:<app id>. Role ceiling: member, admin, or owner (never above your own). Access: read or read-write. Repeat for more targets; on update the list replaces the current grants.",
    ),
    flag(
      "--expires-at <when>",
      "never | <days>d | ISO 8601 date",
      defaultValue === "required" ? "90d" : defaultValue,
      "When the token stops working. never means it does not expire.",
    ),
  ];
}

function secretFlags(): HelpFlag[] {
  return [
    flag(
      "--output-file <path>",
      "string",
      "required",
      "File that receives the secret (mode 0600). The secret is never printed.",
    ),
    flag(
      "--secret-format <format>",
      "env | raw",
      "env",
      `env writes NAME=secret for env files and env injection; raw writes the bare secret.`,
    ),
    flag(
      "--env-var <name>",
      "string",
      DEFAULT_PERSONAL_ACCESS_TOKEN_ENV_VAR,
      "Variable name for --secret-format env.",
    ),
    flag(
      "--append",
      "boolean",
      "false",
      "Add the env line to an existing file (which must not be readable by other users); creates the file if missing.",
    ),
    flag(
      "--force",
      "boolean",
      "false",
      "Overwrite an existing file, or with --append replace an existing definition of the variable.",
    ),
  ];
}

function flag(syntax: string, type: string, defaultValue: string, description: string): HelpFlag {
  return { syntax, type, defaultValue, description };
}
