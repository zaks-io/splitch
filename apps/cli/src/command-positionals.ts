import { getRoute } from "@splitch/sdk/control-plane";
import type { CliCommandDefinition } from "./command-registry.js";
import { SplitchCliError } from "./errors.js";
import type { ParsedInvocation } from "./parse-args.js";

/** Path params filled from `--app` / `--env` context, never as CLI positionals. */
const SCOPE_PATH_PARAMS = new Set(["appId", "environmentId", "targetEnvironmentId"]);

export interface RequiredPositionalSpec {
  /** Control-plane path / input field name, e.g. `experimentId`. */
  readonly param: string;
  /** Help display name, e.g. `experiment-id`. */
  readonly display: string;
}

/**
 * Required positionals for a command — the same list `--help` renders.
 * Scope path params (App / Environment) are excluded; they come from flags.
 */
export function requiredPositionalSpecs(
  command: CliCommandDefinition,
): readonly RequiredPositionalSpec[] {
  if (command.kind === "flags_verify") {
    return [{ param: "flagKey", display: "flag-key" }];
  }
  if (command.kind.startsWith("cloudflare_")) return [];
  const route = getRoute(command.operationId);
  if (!route) return [];
  const specs: RequiredPositionalSpec[] = [];
  for (const match of route.path.matchAll(/:([A-Za-z0-9_]+)/g)) {
    const name = match[1];
    if (!name || SCOPE_PATH_PARAMS.has(name)) {
      continue;
    }
    specs.push({ param: name, display: positionalDisplayName(name) });
  }
  return specs;
}

export function requiredPositionals(command: CliCommandDefinition): readonly string[] {
  return requiredPositionalSpecs(command).map((spec) => spec.display);
}

/** One usage line matching `renderCommandHelp`, without the `Usage:` header. */
export function commandUsageLine(command: CliCommandDefinition): string {
  const path = command.path.join(" ");
  const args = requiredPositionals(command)
    .map((value) => ` <${value}>`)
    .join("");
  return `splitch ${path}${args} [flags]`;
}

function positionalDisplayName(param: string): string {
  const kebab = param.replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  // Mirror "--app <app> … ID or slug": Flag ID routes accept a key too.
  return kebab === "flag-id" ? "flag-id-or-key" : kebab;
}

/**
 * First required path param that is unsatisfied after consulting every source
 * for that slot (`--org`, `--body-json`, then the next unused argv positional).
 * Argv is bound only to slots still empty — never before knowing which are filled.
 *
 * `flags verify` is argv-only: it never reads `--body-json` for the Flag key.
 */
export function missingRequiredPositional(
  command: CliCommandDefinition,
  invocation: ParsedInvocation,
): string | undefined {
  if (command.kind === "flags_verify") {
    return invocation.positionals[0] ? undefined : "flag-key";
  }
  const specs = requiredPositionalSpecs(command);
  const body = parseBodyJsonRecord(invocation.flags.bodyJson);
  let positionalIndex = 0;
  for (const spec of specs) {
    if (pathParamAlreadyFilled(spec.param, invocation.flags.org, body)) {
      continue;
    }
    const token = invocation.positionals[positionalIndex];
    if (token) {
      positionalIndex += 1;
      continue;
    }
    return spec.display;
  }
  return undefined;
}

/** Excess argv: either a path param supplied twice, or a token with no slot. */
export type ExcessPositional =
  | { readonly kind: "conflict"; readonly display: string }
  | { readonly kind: "unexpected"; readonly token: string };

/**
 * When argv has more tokens than unfilled path slots: if a slot is already
 * filled (`--org` / `--body-json`), that is a double supply; otherwise the
 * first leftover token is unexpected (including commands with zero path params).
 */
export function conflictingSuppliedPositional(
  command: CliCommandDefinition,
  invocation: ParsedInvocation,
): ExcessPositional | undefined {
  if (command.kind === "flags_verify") {
    if (invocation.positionals.length <= 1) {
      return undefined;
    }
    return { kind: "unexpected", token: invocation.positionals[1] ?? "" };
  }
  const specs = requiredPositionalSpecs(command);
  const body = parseBodyJsonRecord(invocation.flags.bodyJson);
  const unfilledCount = specs.filter(
    (spec) => !pathParamAlreadyFilled(spec.param, invocation.flags.org, body),
  ).length;
  if (invocation.positionals.length <= unfilledCount) {
    return undefined;
  }
  const conflict = specs.find((spec) =>
    pathParamAlreadyFilled(spec.param, invocation.flags.org, body),
  );
  if (conflict) {
    return { kind: "conflict", display: conflict.display };
  }
  const token = invocation.positionals[unfilledCount];
  // length > unfilledCount guarantees an argv token at that index.
  return { kind: "unexpected", token: token ?? "" };
}

/** True when `--org` or a non-empty `--body-json` string already fills this path param. */
function pathParamAlreadyFilled(
  param: string,
  orgFlag: string | undefined,
  body: Record<string, unknown> | undefined,
): boolean {
  // Documented `--org` flag fills `:orgId` without a positional (quickstart /
  // mcp-and-cli surfaces teach `apps create --org <orgId>`).
  if (param === "orgId" && orgFlag) {
    return true;
  }
  const fromBody = body?.[param];
  return typeof fromBody === "string" && fromBody.length > 0;
}

/**
 * Parse `--body-json` into a record when present and well-formed.
 * Throws CLI_USAGE_INVALID on malformed JSON — the positional gate runs before
 * `applyBodyJson`, so a swallowed parse here would mis-name a missing argument.
 */
function parseBodyJsonRecord(bodyJson: string | undefined): Record<string, unknown> | undefined {
  if (!bodyJson) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyJson);
  } catch {
    throw malformedBodyJsonError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw malformedBodyJsonError();
  }
  return parsed as Record<string, unknown>;
}

function malformedBodyJsonError(): SplitchCliError {
  return new SplitchCliError({
    code: "CLI_USAGE_INVALID",
    causeSummary: "Malformed --body-json",
    remediation: "Pass a JSON object with --body-json",
  });
}

/**
 * Fail loud before the control-plane SDK builds a path, so operators never see
 * `control-plane-sdk: … missing path param`.
 */
export function assertPathParamsPresent(
  command: CliCommandDefinition,
  input: Record<string, unknown>,
): void {
  if (command.kind === "flags_verify") {
    return;
  }
  for (const spec of requiredPositionalSpecs(command)) {
    const value = input[spec.param];
    if (typeof value === "string" && value.length > 0) {
      continue;
    }
    throw missingPositionalError(spec.display);
  }
}

export function missingPositionalError(display: string): SplitchCliError {
  return new SplitchCliError({
    code: "CLI_USAGE_INVALID",
    causeSummary: `Missing required argument <${display}>`,
    // Usage is printed as its own block by execute.ts — keep remediation one clause.
    remediation: `Pass <${display}>`,
  });
}

function conflictingPositionalError(display: string): SplitchCliError {
  return new SplitchCliError({
    code: "CLI_USAGE_INVALID",
    causeSummary: `<${display}> was supplied more than once`,
    remediation: `Pass <${display}> only once (positional or via --org / --body-json)`,
  });
}

function unexpectedPositionalError(token: string): SplitchCliError {
  return new SplitchCliError({
    code: "CLI_USAGE_INVALID",
    causeSummary: `Unexpected argument ${token}`,
    remediation: `Remove ${token}`,
  });
}

export function excessPositionalError(excess: ExcessPositional): SplitchCliError {
  if (excess.kind === "conflict") {
    return conflictingPositionalError(excess.display);
  }
  return unexpectedPositionalError(excess.token);
}
