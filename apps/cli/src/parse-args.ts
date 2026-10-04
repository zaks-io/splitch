import { SplitchCliError } from "./errors.js";

export interface ParsedGlobalFlags {
  readonly json: boolean;
  readonly app?: string;
  readonly env?: string;
  readonly org?: string;
  readonly confirm: boolean;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly summary: boolean;
  readonly endpoint?: string;
  readonly name?: string;
  readonly key?: string;
  readonly targetingKey?: string;
  readonly idType?: string;
  readonly contextJson?: string;
  readonly bodyJson?: string;
  readonly by?: string;
  readonly variants?: string;
  readonly lifecycleClass?: string;
  readonly owner?: string;
  readonly expiresAt?: string;
  readonly fromEnvironmentId?: string;
  readonly enabled?: boolean;
  readonly rollout?: number | null;
  readonly idempotencyKey?: string;
  readonly outputFile?: string;
  /** Personal Access Token grants, `<all|org:org_…|app:app_…>:<role>:<read|read-write>`. */
  readonly grant: readonly string[];
  readonly secretFormat?: string;
  readonly envVar?: string;
  readonly append: boolean;
  readonly when: readonly string[];
  readonly serve?: string;
  readonly wranglerEnv?: string;
  /**
   * Route query params as kebab-case flag names → raw string values.
   * Validated against the command's OpenAPI query schema after resolution.
   */
  readonly queryFlags: Readonly<Record<string, string>>;
}

export interface ParsedInvocation {
  readonly rawArgs: readonly string[];
  readonly metaCommand?: string;
  readonly commandPath: readonly string[];
  readonly positionals: readonly string[];
  readonly flags: ParsedGlobalFlags;
}

const META_COMMANDS = new Set(["login", "logout", "use", "context", "health"]);

const BOOLEAN_FLAGS = new Set(["json", "confirm", "help", "dryRun", "force", "summary", "append"]);

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
  "idType",
  "contextJson",
  "bodyJson",
  "by",
  "variants",
  "lifecycleClass",
  "owner",
  "expiresAt",
  "fromEnvironmentId",
  "enabled",
  "rollout",
  "idempotencyKey",
  "outputFile",
  "grant",
  "secretFormat",
  "envVar",
  "when",
  "serve",
  "wranglerEnv",
]);

const REPEATABLE_FLAGS = new Set(["when", "grant"]);

type ParsedFlagValue = string | boolean | string[];

export function parseInvocation(args: readonly string[]): ParsedInvocation {
  const flags: Record<string, ParsedFlagValue> = {};
  const queryFlags: Record<string, string> = {};
  const seenFlags = new Set<string>();
  const positionals: string[] = [];
  const commandTokens: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      continue;
    }
    if (token.startsWith("--")) {
      index = parseFlagToken(token, args, index, flags, queryFlags, seenFlags);
      continue;
    }
    if (commandTokens.length < 3 && !positionals.length && isCommandToken(token, commandTokens)) {
      commandTokens.push(token);
      continue;
    }
    positionals.push(token);
  }

  const parsedFlags = toParsedFlags(flags, queryFlags);
  const meta = commandTokens[0];
  if (meta && META_COMMANDS.has(meta) && commandTokens.length === 1) {
    return {
      rawArgs: args,
      metaCommand: meta,
      commandPath: [],
      positionals,
      flags: parsedFlags,
    };
  }

  return {
    rawArgs: args,
    commandPath: commandTokens,
    positionals,
    flags: parsedFlags,
  };
}

function parseFlagToken(
  key: string,
  args: readonly string[],
  index: number,
  flags: Record<string, ParsedFlagValue>,
  queryFlags: Record<string, string>,
  seenFlags: Set<string>,
): number {
  const name = toCamel(key);
  const kebab = key.slice(2);
  if (!KNOWN_FLAGS.has(name)) {
    // Route query flags are command-specific; accept the raw kebab here and
    // validate against the OpenAPI query schema once the command is known.
    return parseQueryFlagToken(key, kebab, args, index, queryFlags, seenFlags);
  }
  if (seenFlags.has(name) && !REPEATABLE_FLAGS.has(name)) {
    throw new SplitchCliError({
      code: "CLI_USAGE_INVALID",
      causeSummary: `${key} was supplied more than once`,
      remediation: `Pass ${key} only once`,
    });
  }
  seenFlags.add(name);
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

function parseQueryFlagToken(
  key: string,
  kebab: string,
  args: readonly string[],
  index: number,
  queryFlags: Record<string, string>,
  seenFlags: Set<string>,
): number {
  const seenKey = `query:${kebab}`;
  if (seenFlags.has(seenKey)) {
    throw new SplitchCliError({
      code: "CLI_USAGE_INVALID",
      causeSummary: `${key} was supplied more than once`,
      remediation: `Pass ${key} only once`,
    });
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new SplitchCliError({
      code: "CLI_USAGE_INVALID",
      causeSummary: `${key} requires a value`,
      remediation: `Pass a value immediately after ${key}`,
    });
  }
  seenFlags.add(seenKey);
  queryFlags[kebab] = value;
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

function toParsedFlags(
  flags: Record<string, ParsedFlagValue>,
  queryFlags: Readonly<Record<string, string>>,
): ParsedGlobalFlags {
  return {
    json: Boolean(flags.json),
    confirm: Boolean(flags.confirm),
    dryRun: Boolean(flags.dryRun),
    force: Boolean(flags.force),
    summary: Boolean(flags.summary),
    app: stringFlag(flags.app),
    env: stringFlag(flags.env),
    org: stringFlag(flags.org),
    endpoint: stringFlag(flags.endpoint),
    name: stringFlag(flags.name),
    key: stringFlag(flags.key),
    targetingKey: stringFlag(flags.targetingKey),
    idType: stringFlag(flags.idType),
    contextJson: stringFlag(flags.contextJson),
    bodyJson: stringFlag(flags.bodyJson),
    by: stringFlag(flags.by),
    variants: stringFlag(flags.variants),
    lifecycleClass: stringFlag(flags.lifecycleClass),
    owner: stringFlag(flags.owner),
    expiresAt: stringFlag(flags.expiresAt),
    fromEnvironmentId: stringFlag(flags.fromEnvironmentId),
    enabled: parseEnabledFlag(flags.enabled),
    rollout: parseRolloutFlag(flags.rollout),
    idempotencyKey: stringFlag(flags.idempotencyKey),
    outputFile: stringFlag(flags.outputFile),
    grant: Array.isArray(flags.grant) ? flags.grant : [],
    secretFormat: stringFlag(flags.secretFormat),
    envVar: stringFlag(flags.envVar),
    append: Boolean(flags.append),
    when: Array.isArray(flags.when) ? flags.when : [],
    serve: stringFlag(flags.serve),
    wranglerEnv: stringFlag(flags.wranglerEnv),
    queryFlags: { ...queryFlags },
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
