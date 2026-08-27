import { SplitchCliError } from "./errors.js";

export interface ParsedGlobalFlags {
  readonly json: boolean;
  readonly app?: string;
  readonly env?: string;
  readonly org?: string;
  readonly confirm: boolean;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly withConfig: boolean;
  readonly endpoint?: string;
  readonly name?: string;
  readonly key?: string;
  readonly targetingKey?: string;
  readonly contextJson?: string;
  readonly bodyJson?: string;
  readonly variants?: string;
  readonly fromEnvironmentId?: string;
  readonly enabled?: boolean;
  readonly rollout?: number | null;
  readonly idempotencyKey?: string;
  readonly outputFile?: string;
  readonly when: readonly string[];
  readonly serve?: string;
}

export interface ParsedInvocation {
  readonly metaCommand?: string;
  readonly commandPath: readonly string[];
  readonly positionals: readonly string[];
  readonly flags: ParsedGlobalFlags;
}

const META_COMMANDS = new Set(["login", "logout", "use", "context", "health"]);

const BOOLEAN_FLAGS = new Set(["json", "confirm", "help", "dryRun", "force", "withConfig"]);

/**
 * Every flag the CLI reads, keyed as it appears after `toCamel`.
 *
 * An unrecognised flag used to be collected and then silently dropped, so
 * `--org-id org_x` reached the API as a request missing its Organization and
 * came back as a schema violation pointing at the body. Naming the typo is the
 * difference between one fix and a search through the source.
 */
const KNOWN_FLAGS = new Set([
  ...BOOLEAN_FLAGS,
  "app",
  "env",
  "org",
  "endpoint",
  "name",
  "key",
  "targetingKey",
  "contextJson",
  "bodyJson",
  "variants",
  "fromEnvironmentId",
  "enabled",
  "rollout",
  "idempotencyKey",
  "outputFile",
  "when",
  "serve",
]);

const REPEATABLE_FLAGS = new Set(["when"]);

type ParsedFlagValue = string | boolean | string[];

export function parseInvocation(args: readonly string[]): ParsedInvocation {
  const flags: Record<string, ParsedFlagValue> = {
    confirm: false,
    json: false,
    dryRun: false,
    force: false,
  };
  const positionals: string[] = [];
  const commandTokens: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      continue;
    }
    if (token.startsWith("--")) {
      index = parseFlagToken(token, args, index, flags);
      continue;
    }
    if (commandTokens.length < 3 && !positionals.length && isCommandToken(token, commandTokens)) {
      commandTokens.push(token);
      continue;
    }
    positionals.push(token);
  }

  const meta = commandTokens[0];
  if (meta && META_COMMANDS.has(meta) && commandTokens.length === 1) {
    return {
      metaCommand: meta,
      commandPath: [],
      positionals,
      flags: toParsedFlags(flags),
    };
  }

  return {
    commandPath: commandTokens,
    positionals,
    flags: toParsedFlags(flags),
  };
}

function parseFlagToken(
  key: string,
  args: readonly string[],
  index: number,
  flags: Record<string, ParsedFlagValue>,
): number {
  const name = toCamel(key);
  if (!KNOWN_FLAGS.has(name)) {
    throw new SplitchCliError({
      code: "CLI_USAGE_INVALID",
      causeSummary: `unknown flag ${key}`,
      remediation: `Remove ${key} or run the command with --help to list the flags it accepts`,
    });
  }
  if (BOOLEAN_FLAGS.has(name)) {
    flags[name] = true;
    return index;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new SplitchCliError({
      code: "CLI_USAGE_INVALID",
      causeSummary: `${key} requires a value`,
      remediation: `Pass a value immediately after ${key}`,
    });
  }
  if (REPEATABLE_FLAGS.has(name)) {
    const existing = flags[name];
    flags[name] = Array.isArray(existing) ? [...existing, value] : [value];
    return index + 1;
  }
  flags[name] = value;
  return index + 1;
}

function isCommandToken(token: string, existing: readonly string[]): boolean {
  if (existing.length === 0) {
    return /^[a-z][a-z0-9-]*$/.test(token);
  }
  if (existing.length === 1) {
    return /^[a-z][a-z0-9-]*$/.test(token);
  }
  return false;
}

function toCamel(flag: string): string {
  return flag
    .slice(2)
    .split("-")
    .map((part, index) => (index === 0 ? part : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`))
    .join("");
}

function toParsedFlags(flags: Record<string, ParsedFlagValue>): ParsedGlobalFlags {
  return {
    json: Boolean(flags.json),
    confirm: Boolean(flags.confirm),
    dryRun: Boolean(flags.dryRun),
    force: Boolean(flags.force),
    withConfig: Boolean(flags.withConfig),
    app: stringFlag(flags.app),
    env: stringFlag(flags.env),
    org: stringFlag(flags.org),
    endpoint: stringFlag(flags.endpoint),
    name: stringFlag(flags.name),
    key: stringFlag(flags.key),
    targetingKey: stringFlag(flags.targetingKey),
    contextJson: stringFlag(flags.contextJson),
    bodyJson: stringFlag(flags.bodyJson),
    variants: stringFlag(flags.variants),
    fromEnvironmentId: stringFlag(flags.fromEnvironmentId),
    enabled: parseEnabledFlag(flags.enabled),
    rollout: parseRolloutFlag(flags.rollout),
    idempotencyKey: stringFlag(flags.idempotencyKey),
    outputFile: stringFlag(flags.outputFile),
    when: Array.isArray(flags.when) ? flags.when : [],
    serve: stringFlag(flags.serve),
  };
}

// `--rollout` moves the share of live traffic in the baseline rollout, so a
// silent coerce (NaN, "" -> 0) would quietly roll it back to nobody. Accept only
// a number in 0-100 or the literal "none" to clear it; anything else is loud.
function parseRolloutFlag(value: ParsedFlagValue | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === "none") return null;
  // `Number("")` and `Number(" ")` are both 0, so a blank value would silently
  // become a 0% rollout instead of a usage error.
  const percentage = typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw new SplitchCliError({
      code: "CLI_USAGE_INVALID",
      causeSummary: `--rollout must be a number from 0 through 100 or "none", but received "${String(value)}"`,
      remediation: "Pass a percentage from 0 through 100 or use none to clear the rollout",
    });
  }
  return percentage;
}

// `--enabled` inverts a Flag's state, so a silent coerce of anything-but-"true"
// to false would let `--enabled TRUE` (or a typo) DISABLE the Flag. Accept only
// the two boolean literals; anything else is a loud usage error.
function parseEnabledFlag(value: ParsedFlagValue | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new SplitchCliError({
    code: "CLI_USAGE_INVALID",
    causeSummary: `--enabled must be "true" or "false", but received "${String(value)}"`,
    remediation: "Pass either --enabled true or --enabled false",
  });
}

function stringFlag(value: ParsedFlagValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function longestMatchingCommandPath(
  tokens: readonly string[],
  candidates: ReadonlySet<string>,
): readonly string[] {
  for (let length = Math.min(tokens.length, 3); length >= 1; length -= 1) {
    const candidate = tokens.slice(0, length).join("\0");
    if (candidates.has(candidate)) {
      return tokens.slice(0, length);
    }
  }
  return tokens;
}
