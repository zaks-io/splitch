import { deriveMcpTools, getRoute } from "@splitch/contracts";
import { CLI_COMMANDS, type CliCommandDefinition, META_COMMANDS } from "./command-registry.js";
import { META_DESCRIPTIONS, META_EXAMPLES } from "./help-meta.js";

interface HelpFlag {
  readonly syntax: string;
  readonly type: string;
  readonly defaultValue: string;
  readonly description: string;
}

const TOOL_BY_OPERATION = new Map(deriveMcpTools().map((tool) => [tool.name, tool]));

export function renderHelp(args: readonly string[]): string | undefined {
  if (!args.some((arg) => arg === "--help" || arg === "-h")) return undefined;
  const path = args.filter((arg) => !arg.startsWith("-")).slice(0, 2);
  if (path.length === 0) return renderRootHelp();
  if (path.length === 1 && isMetaCommand(path[0])) return renderMetaHelp(path[0]);
  const command = CLI_COMMANDS.find((candidate) => candidate.path.join("\0") === path.join("\0"));
  if (command) return renderCommandHelp(command);
  if (path.length === 1 && commandGroups().has(path[0] ?? ""))
    return renderGroupHelp(path[0] ?? "");
  return undefined;
}

export function renderRootHelp(): string {
  const groups = [...commandGroups()].sort();
  return [
    "splitch - agent-readable feature flag and experimentation control plane",
    "",
    "Usage:",
    "  splitch <command> [flags]",
    "  splitch <resource> <action> [arguments] [flags]",
    "",
    "Commands:",
    ...META_COMMANDS.map((command) => `  ${command.padEnd(16)}${META_DESCRIPTIONS[command]}`),
    "",
    "Resource groups:",
    ...groups.map((group) => `  ${group}`),
    "",
    "Flags:",
    formatFlags([helpFlag()]),
    "",
    "Credential semantics:",
    "  Client Key  Public data-plane key for browsers, mobile apps, and other untrusted clients.",
    "  API Key     Secret data-plane key for trusted servers; a newly created value is shown once.",
    "",
    "Example:",
    "  splitch flags list --app checkout --json",
    "",
    "Run `splitch <command> --help` or `splitch <resource> <action> --help` for details.",
  ].join("\n");
}

export function renderMetaHelp(command: (typeof META_COMMANDS)[number]): string {
  return [
    META_DESCRIPTIONS[command],
    "",
    "Usage:",
    `  splitch ${metaUsage(command)}`,
    "",
    "Flags:",
    formatFlags(metaFlags(command)),
    "",
    "Example:",
    `  ${META_EXAMPLES[command]}`,
  ].join("\n");
}

export function renderCommandHelp(command: CliCommandDefinition): string {
  const path = command.path.join(" ");
  const notes = credentialNotes(command);
  return [
    commandDescription(command),
    "",
    "Usage:",
    `  splitch ${path}${positionals(command)
      .map((value) => ` <${value}>`)
      .join("")} [flags]`,
    "",
    "Flags:",
    formatFlags(commandFlags(command)),
    ...(notes.length > 0 ? ["", "Credential semantics:", ...notes.map((note) => `  ${note}`)] : []),
    "",
    "Example:",
    `  ${commandExample(command)}`,
  ].join("\n");
}

function renderGroupHelp(group: string): string {
  const commands = CLI_COMMANDS.filter((command) => command.path[0] === group);
  return [
    `Manage ${group} resources.`,
    "",
    "Usage:",
    `  splitch ${group} <action> [arguments] [flags]`,
    "",
    "Commands:",
    ...commands.map(
      (command) => `  ${(command.path[1] ?? "").padEnd(16)}${commandDescription(command)}`,
    ),
    "",
    "Flags:",
    formatFlags([helpFlag()]),
    "",
    "Example:",
    `  splitch ${group} ${commands[0]?.path[1] ?? "list"} --help`,
  ].join("\n");
}

function commandGroups(): Set<string> {
  return new Set(CLI_COMMANDS.map((command) => command.path[0]).filter(Boolean) as string[]);
}

function commandDescription(command: CliCommandDefinition): string {
  if (command.kind === "flags_verify") {
    return "Verify a Flag KEY through the data plane without firing an Exposure.";
  }
  if (command.kind === "env_policy_get") return "Get the selected Environment Policy.";
  if (command.kind === "env_policy_set") return "Update the selected Environment Policy.";
  return TOOL_BY_OPERATION.get(command.operationId)?.description ?? `Run ${command.operationId}.`;
}

function positionals(command: CliCommandDefinition): string[] {
  if (command.kind === "flags_verify") return ["flag-key"];
  const route = getRoute(command.operationId);
  if (!route) return [];
  return [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)]
    .map((match) => match[1])
    .filter(
      (name): name is string =>
        Boolean(name) && !["appId", "environmentId", "targetEnvironmentId"].includes(name ?? ""),
    )
    .map((value) => {
      const kebab = value.replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
      // Mirror "--app <app> … ID or slug": Flag ID routes accept a key too.
      return kebab === "flag-id" ? "flag-id-or-key" : kebab;
    });
}

function commandFlags(command: CliCommandDefinition): HelpFlag[] {
  const fields = inputFields(command.operationId);
  const flags = scopeFlags(command, fields);
  flags.push(...operationFlags(command));
  if (hasRequestBody(command.operationId) && command.kind !== "flags_verify") {
    flags.push(flag("--body-json <json>", "JSON object", "none", "Control-plane request fields."));
  }
  if (fields.has("idempotency_key")) {
    flags.push(
      flag("--idempotency-key <key>", "string", "generated", "Stable retry key for this mutation."),
    );
  }
  if (command.supportsConfirm)
    flags.push(flag("--confirm", "boolean", "false", "Approve and apply a Policy-gated change."));
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

function metaFlags(command: (typeof META_COMMANDS)[number]): HelpFlag[] {
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

function metaUsage(command: (typeof META_COMMANDS)[number]): string {
  if (command === "login") return "login [--app <app>] [flags]";
  if (command === "use") return "use [--app <app>] [--env <environment>] [flags]";
  return `${command} [flags]`;
}

function commandExample(command: CliCommandDefinition): string {
  if (command.operationId === "flags_create")
    return "splitch flags create --key checkout --variants on,off --json";
  if (command.kind === "flags_verify")
    return "splitch flags verify checkout --targeting-key user-123 --json";
  const parts = ["splitch", ...command.path, ...positionals(command).map((name) => `<${name}>`)];
  if (command.operationId === "flags_test_eval") parts.push("--targeting-key", "user-123");
  else if (hasRequestBody(command.operationId)) parts.push("--body-json", "'<json>'");
  parts.push("--json");
  return parts.join(" ");
}

function credentialNotes(command: CliCommandDefinition): string[] {
  const group = command.path[0];
  if (group === "client-key" || command.kind === "flags_verify") {
    return [
      "Client Key is public and safe for untrusted clients; flags verify fetches it automatically.",
    ];
  }
  if (group === "api-keys") {
    return [
      "API Key is secret and server-side only; a newly created value is shown once and cannot be read back.",
    ];
  }
  return [];
}

function inputFields(operationId: string): Set<string> {
  const schema = TOOL_BY_OPERATION.get(operationId)?.inputSchema;
  if (!schema || !("shape" in schema)) return new Set();
  return new Set(Object.keys(schema.shape as Record<string, unknown>));
}

function hasRequestBody(operationId: string): boolean {
  return Boolean(getRoute(operationId)?.openapi.request?.body);
}

function formatFlags(flags: readonly HelpFlag[]): string {
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

function helpFlag(): HelpFlag {
  return flag("-h, --help", "boolean", "false", "Show help and exit.");
}

function isMetaCommand(value: string | undefined): value is (typeof META_COMMANDS)[number] {
  return META_COMMANDS.includes(value as (typeof META_COMMANDS)[number]);
}
