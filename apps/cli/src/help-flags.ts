import { API_KEY_CREATE_OPERATION_ID } from "./api-key-output.js";
import { type CliCommandDefinition, META_COMMANDS } from "./command-registry.js";
import { commandHasBodyJson } from "./help-body-json.js";
import { toolByOperation } from "./help-command-description.js";
import { deleteModeHelpFlags } from "./help-delete-flags.js";

interface HelpFlag {
  readonly syntax: string;
  readonly type: string;
  readonly defaultValue: string;
  readonly description: string;
}

export function commandFlags(command: CliCommandDefinition): HelpFlag[] {
  const fields = inputFields(command.operationId);
  const flags = scopeFlags(command, fields);
  flags.push(...operationFlags(command));
  if (commandHasBodyJson(command)) {
    flags.push(
      flag(
        "--body-json <json>",
        "JSON object",
        "none",
        "Request body fields; see Request body below.",
      ),
    );
  }
  if (fields.has("idempotency_key")) {
    flags.push(
      flag("--idempotency-key <key>", "string", "generated", "Stable retry key for this mutation."),
    );
  }
  if (command.operationId === API_KEY_CREATE_OPERATION_ID) {
    flags.push(
      flag(
        "--output-file <path>",
        "string",
        "none",
        "Write the once-only secret to a new 0600 file instead of stdout; the payload reports valueWrittenTo.",
      ),
    );
  }
  if (command.supportsConfirm)
    flags.push(flag("--confirm", "boolean", "false", "Approve and apply a Policy-gated change."));
  flags.push(...deleteModeHelpFlags(command));
  flags.push(flag("--json", "boolean", "false", "Write machine-readable JSON to stdout."));
  flags.push(helpFlag());
  return flags;
}

function scopeFlags(command: CliCommandDefinition, fields: ReadonlySet<string>): HelpFlag[] {
  const flags: HelpFlag[] = [];
  if (command.needsApp)
    flags.push(flag("--app <app>", "string", "SPLITCH_APP or config", "App ID or slug."));
  if (command.needsEnvironment) {
    flags.push(
      flag("--env <environment>", "string", "SPLITCH_ENV or config", "Environment ID or slug."),
    );
  } else if (command.operationId === "flags_list") {
    flags.push(
      flag(
        "--env <environment>",
        "string",
        "SPLITCH_ENV or config",
        "Environment ID or slug used with --with-config.",
      ),
    );
  } else if (fields.has("environmentId")) {
    flags.push(
      flag(
        "--env <environment>",
        "string",
        "none",
        "Optional Environment ID or slug filter (Policy context).",
      ),
    );
  }
  if (fields.has("orgId"))
    flags.push(flag("--org <organization>", "string", "none", "Organization ID."));
  if (fields.has("name")) flags.push(flag("--name <name>", "string", "none", "Resource name."));
  if (fields.has("key")) {
    const description = command.operationId === "flags_create" ? "Flag KEY." : "Resource key.";
    flags.push(flag("--key <key>", "string", "none", description));
  }
  return flags;
}

function operationFlags(command: CliCommandDefinition): HelpFlag[] {
  switch (command.operationId) {
    case "flags_list":
      return [
        flag(
          "--with-config",
          "boolean",
          "false",
          "Include enabled, rollout, and Default Variant for one Environment.",
        ),
      ];
    case "flags_create":
      return [
        flag("--variants <names>", "comma-separated strings", "none", "Boolean Variant names."),
      ];
    case "flags_promote":
      return [flag("--from-environment-id <id>", "string", "none", "Source Environment ID.")];
    case "flag_config_update":
      return [
        flag("--enabled <boolean>", "boolean", "current value", "Set the Flag enabled state."),
        flag(
          "--rollout <percent|none>",
          "number | none",
          "current value",
          "Set or clear the baseline rollout.",
        ),
      ];
    case "flags_test_eval":
    case "sdk_verify":
      return [
        flag("--targeting-key <key>", "string", "none", "Entity Targeting Key."),
        flag(
          "--context-json <json>",
          "JSON object",
          '{"attributes":{}}',
          "Evaluation Context fields.",
        ),
      ];
    default:
      return [];
  }
}

export function metaFlags(command: (typeof META_COMMANDS)[number]): HelpFlag[] {
  const flags: HelpFlag[] = [];
  if (["login", "use", "context"].includes(command))
    flags.push(flag("--app <app>", "string", metaScopeDefault(command, "app"), "App ID or slug."));
  if (["use", "context"].includes(command))
    flags.push(
      flag(
        "--env <environment>",
        "string",
        metaScopeDefault(command, "env"),
        "Environment ID or slug.",
      ),
    );
  if (command === "health")
    flags.push(
      flag(
        "--endpoint <url>",
        "URL",
        "resolved platform target origin",
        "Control Plane API base URL.",
      ),
    );
  flags.push(flag("--json", "boolean", "false", "Write machine-readable JSON to stdout."));
  flags.push(helpFlag());
  return flags;
}

function metaScopeDefault(command: (typeof META_COMMANDS)[number], scope: "app" | "env"): string {
  if (command === "use") return "unchanged";
  return scope === "app" ? "SPLITCH_APP or config" : "SPLITCH_ENV or config";
}

function inputFields(operationId: string): Set<string> {
  const schema = toolByOperation.get(operationId)?.inputSchema;
  if (!schema || !("shape" in schema)) return new Set();
  return new Set(Object.keys(schema.shape as Record<string, unknown>));
}

export function formatFlags(flags: readonly HelpFlag[]): string {
  const width = Math.max(...flags.map((item) => item.syntax.length));
  return flags
    .map(
      (item) =>
        `  ${item.syntax.padEnd(width)}  [type: ${item.type}; default: ${item.defaultValue}] ${item.description}`,
    )
    .join("\n");
}

function flag(syntax: string, type: string, defaultValue: string, description: string): HelpFlag {
  return { syntax, type, defaultValue, description };
}

export function helpFlag(): HelpFlag {
  return flag("-h, --help", "boolean", "false", "Show help and exit.");
}

export function versionFlag(): HelpFlag {
  return flag("-v, --version", "boolean", "false", "Show the installed CLI version and exit.");
}
