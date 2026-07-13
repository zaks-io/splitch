export interface ParsedGlobalFlags {
  readonly json: boolean;
  readonly app?: string;
  readonly env?: string;
  readonly org?: string;
  readonly confirm: boolean;
  readonly endpoint?: string;
  readonly name?: string;
  readonly key?: string;
  readonly targetingKey?: string;
  readonly contextJson?: string;
  readonly bodyJson?: string;
  readonly fromEnvironmentId?: string;
  readonly enabled?: boolean;
}

export interface ParsedInvocation {
  readonly metaCommand?: string;
  readonly commandPath: readonly string[];
  readonly positionals: readonly string[];
  readonly flags: ParsedGlobalFlags;
}

const META_COMMANDS = new Set(["login", "logout", "use", "context", "health"]);

export function parseInvocation(args: readonly string[]): ParsedInvocation {
  const flags: Record<string, string | boolean> = { confirm: false, json: false };
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
  flags: Record<string, string | boolean>,
): number {
  if (key === "--json" || key === "--confirm") {
    flags[toCamel(key)] = true;
    return index;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`splitch: ${key} requires a value`);
  }
  flags[toCamel(key)] = value;
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

function toParsedFlags(flags: Record<string, string | boolean>): ParsedGlobalFlags {
  return {
    json: Boolean(flags.json),
    confirm: Boolean(flags.confirm),
    app: stringFlag(flags.app),
    env: stringFlag(flags.env),
    org: stringFlag(flags.org),
    endpoint: stringFlag(flags.endpoint),
    name: stringFlag(flags.name),
    key: stringFlag(flags.key),
    targetingKey: stringFlag(flags.targetingKey),
    contextJson: stringFlag(flags.contextJson),
    bodyJson: stringFlag(flags.bodyJson),
    fromEnvironmentId: stringFlag(flags.fromEnvironmentId),
    enabled: parseEnabledFlag(flags.enabled),
  };
}

// `--enabled` inverts a Flag's state, so a silent coerce of anything-but-"true"
// to false would let `--enabled TRUE` (or a typo) DISABLE the Flag. Accept only
// the two boolean literals; anything else is a loud usage error.
function parseEnabledFlag(value: string | boolean | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`splitch: --enabled must be "true" or "false", got "${String(value)}"`);
}

function stringFlag(value: string | boolean | undefined): string | undefined {
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
