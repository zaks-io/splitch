import { CLI_COMMANDS, type CliCommandDefinition, META_COMMANDS } from "./command-registry.js";
import { commandDescription } from "./help-command-description.js";
import { META_DESCRIPTIONS } from "./help-meta.js";

/**
 * The published command surface, derived from the same registry `runCli`
 * dispatches on. The docs site renders this into `/docs/cli`, so a command an
 * agent reads about is a command the binary answers to.
 */
export interface CliCommandReferenceEntry {
  /** As typed, e.g. `splitch flag-config update`. */
  readonly command: string;
  /** Which selectors the command resolves before it runs. */
  readonly scope: "none" | "app" | "app+environment" | "environment";
  /** Whether the command parses `--confirm` (Policy-gated apply path). */
  readonly supportsConfirm: boolean;
  readonly description: string;
}

function scopeOf(command: CliCommandDefinition): CliCommandReferenceEntry["scope"] {
  if (command.needsApp && command.needsEnvironment) return "app+environment";
  if (command.needsApp) return "app";
  if (command.needsEnvironment) return "environment";
  return "none";
}

export function cliCommandReference(): readonly CliCommandReferenceEntry[] {
  const meta = META_COMMANDS.map((command) => ({
    command: `splitch ${command}`,
    scope: "none" as const,
    supportsConfirm: false,
    description: META_DESCRIPTIONS[command],
  }));
  const operations = CLI_COMMANDS.map((command) => ({
    command: `splitch ${command.path.join(" ")}`,
    scope: scopeOf(command),
    supportsConfirm: command.supportsConfirm,
    description: commandDescription(command),
  })).sort((left, right) => left.command.localeCompare(right.command));
  return [...meta, ...operations];
}
