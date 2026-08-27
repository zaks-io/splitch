const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ENV_FLAGS = flagKinds(
  ["-i", "-0", "-v", "--ignore-environment", "--null"],
  ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"],
);
const SUDO_FLAGS = flagKinds(
  ["-A", "-E", "-H", "-K", "-n", "-P", "-S", "-i", "-k", "-s", "-v", "--preserve-env"],
  ["-C", "-D", "-g", "-p", "-u", "--chdir", "--group", "--prompt", "--user"],
);
const COMMAND_FLAGS = flagKinds(["-p", "-v", "-V"], []);
const NICE_FLAGS = flagKinds([], ["-n"]);
const TIMEOUT_FLAGS = flagKinds(
  ["--foreground", "--preserve-status", "-v", "--verbose"],
  ["-k", "-s", "--kill-after", "--signal"],
);

/**
 * @param {string} script
 * @returns {string[]}
 */
export function commandSegments(script) {
  return script
    .replace(/\\[ \t]*\r?\n/g, "")
    .split(/\n/)
    .flatMap((line) => splitControl(line))
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * @param {string} command
 * @returns {string[]}
 */
export function tokenize(command) {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

/**
 * Strip assignment, env, sudo, command, nice, timeout, nohup, and time prefixes.
 *
 * @param {string[]} tokens
 * @returns {string[]}
 */
export function stripWrappers(tokens) {
  let rest = tokens;
  for (;;) {
    const next = stripOneWrapper(rest);
    if (next === null) return rest;
    rest = next;
  }
}

/**
 * @param {string[]} tokens
 * @param {Map<string, "bool" | "value">} flags
 * @returns {{ rest: string[], unparsed: boolean }}
 */
export function skipKnownFlags(tokens, flags) {
  let index = 0;
  while (index < tokens.length) {
    const step = nextFlagIndex(tokens, index, flags);
    if (step.done) return step.result;
    index = step.index;
  }
  return { rest: [], unparsed: false };
}

/**
 * @param {string} token
 * @returns {boolean}
 */
export function hasUnresolvableToken(token) {
  return /\$|`/.test(token);
}

/**
 * @param {string[]} boolFlags
 * @param {string[]} valueFlags
 * @returns {Map<string, "bool" | "value">}
 */
export function flagKinds(boolFlags, valueFlags) {
  return new Map([
    ...boolFlags.map((flag) => /** @type {const} */ ([flag, "bool"])),
    ...valueFlags.map((flag) => /** @type {const} */ ([flag, "value"])),
  ]);
}

function nextFlagIndex(tokens, index, flags) {
  const token = tokens[index] ?? "";
  if (token === "--")
    return { done: true, result: { rest: tokens.slice(index + 1), unparsed: false } };
  if (!token.startsWith("-"))
    return { done: true, result: { rest: tokens.slice(index), unparsed: false } };
  const kind = flags.get(flagName(token));
  if (kind === undefined)
    return { done: true, result: { rest: tokens.slice(index), unparsed: true } };
  if (kind === "value" && !token.includes("=") && tokens[index + 1] === undefined) {
    return { done: true, result: { rest: [], unparsed: true } };
  }
  return { done: false, index: kind === "value" && !token.includes("=") ? index + 2 : index + 1 };
}

function flagName(token) {
  const separator = token.indexOf("=");
  return separator === -1 ? token : token.slice(0, separator);
}

function splitControl(line) {
  const parts = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const consumed = takeControlCharacter(line, index, quote);
    current += consumed.chunk;
    quote = consumed.quote;
    if (consumed.split) {
      parts.push(current);
      current = "";
    }
    index += consumed.advance;
  }
  parts.push(current);
  return parts;
}

function takeControlCharacter(line, index, quote) {
  const character = line[index] ?? "";
  if (quote)
    return { chunk: character, quote: character === quote ? "" : quote, split: false, advance: 0 };
  if (character === "'" || character === '"')
    return { chunk: character, quote: character, split: false, advance: 0 };
  const length = controlDelimiterLength(character, line[index + 1] ?? "");
  if (length === 0) return { chunk: character, quote: "", split: false, advance: 0 };
  return { chunk: "", quote: "", split: true, advance: length - 1 };
}

function controlDelimiterLength(character, next) {
  if (character === ";") return 1;
  if ((character === "&" || character === "|") && next === character) return 2;
  return character === "|" ? 1 : 0;
}

function stripOneWrapper(tokens) {
  const lead = tokens[0] ?? "";
  if (tokens.length === 0) return null;
  if (ASSIGNMENT.test(lead)) return tokens.slice(1);
  if (lead === "sudo") return skipKnownFlags(tokens.slice(1), SUDO_FLAGS).rest;
  if (lead === "env") return stripEnv(tokens.slice(1));
  if (lead === "command") return skipKnownFlags(tokens.slice(1), COMMAND_FLAGS).rest;
  if (lead === "nice") return skipKnownFlags(tokens.slice(1), NICE_FLAGS).rest;
  if (lead === "timeout") return stripTimeout(tokens.slice(1));
  if (lead === "nohup" || lead === "time") return tokens.slice(1);
  return null;
}

function stripEnv(tokens) {
  let rest = tokens;
  let next = stripEnvPrefix(rest);
  while (next !== null) {
    rest = next;
    next = stripEnvPrefix(rest);
  }
  return rest;
}

function stripEnvPrefix(tokens) {
  if (tokens.length === 0) return null;
  if (ASSIGNMENT.test(tokens[0] ?? "")) return tokens.slice(1);
  if (!(tokens[0] ?? "").startsWith("-")) return null;
  const skipped = skipKnownFlags(tokens, ENV_FLAGS);
  return skipped.unparsed || skipped.rest.length === tokens.length ? null : skipped.rest;
}

function stripTimeout(tokens) {
  const skipped = skipKnownFlags(tokens, TIMEOUT_FLAGS);
  if (skipped.rest.length === 0) return skipped.rest;
  return skipped.rest.slice(1);
}
