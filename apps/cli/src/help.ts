import { commandUsageLine } from "./command-positionals.js";
import { CLI_COMMANDS, type CliCommandDefinition, META_COMMANDS } from "./command-registry.js";
import { operationBehaviorNotes } from "./help-behavior-notes.js";
import { renderBodyJsonSection } from "./help-body-json.js";
import { commandDescription } from "./help-command-description.js";
import { commandExample } from "./help-command-example.js";
import { commandFlags, formatFlags, helpFlag, metaFlags, versionFlag } from "./help-flags.js";
import { META_DESCRIPTIONS, META_EXAMPLES } from "./help-meta.js";

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
    "splitch - feature flags and A/B experimentation from your terminal",
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
    formatFlags([versionFlag(), helpFlag()]),
    "",
    "Credential semantics:",
    "  Client Key  Public data-plane key for browsers, mobile apps, and other untrusted clients.",
    "  API Key     Secret data-plane key for trusted servers; a newly created value is shown once.",
    "",
    "Start here:",
    "  splitch login",
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
    ...(command === "use"
      ? [
          "",
          "Project config:",
          '  {"version":1,"app":"app_...","environment":"env_..."}',
          "  Searches the current directory and each parent for splitch.json; the nearest file wins.",
          "  Updates the nearest file, or creates splitch.json in the current directory when none exists.",
        ]
      : []),
    "",
    "Example:",
    `  ${META_EXAMPLES[command]}`,
  ].join("\n");
}

export function renderCommandHelp(command: CliCommandDefinition): string {
  const notes = credentialNotes(command);
  const behaviorNotes = operationBehaviorNotes(command);
  return [
    commandDescription(command),
    "",
    "Usage:",
    `  ${commandUsageLine(command)}`,
    "",
    "Flags:",
    formatFlags(commandFlags(command)),
    ...renderBodyJsonSection(command),
    ...(notes.length > 0 ? ["", "Credential semantics:", ...notes.map((note) => `  ${note}`)] : []),
    ...(behaviorNotes.length > 0
      ? ["", "Behavior:", ...behaviorNotes.map((note) => `  ${note}`)]
      : []),
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

function metaUsage(command: (typeof META_COMMANDS)[number]): string {
  if (command === "login") return "login [--app <app>] [flags]";
  if (command === "use") return "use [--app <app>] [--env <environment>] [flags]";
  return `${command} [flags]`;
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

function isMetaCommand(value: string | undefined): value is (typeof META_COMMANDS)[number] {
  return META_COMMANDS.includes(value as (typeof META_COMMANDS)[number]);
}
