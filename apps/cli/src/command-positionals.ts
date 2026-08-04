import { getRoute } from "@splitch/contracts";
import type { CliCommandDefinition } from "./command-registry.js";
import { SplitchCliError } from "./errors.js";
import type { ParsedInvocation } from "./parse-args.js";

/** Path params filled from `--app` / `--env` context, never as CLI positionals. */
export const SCOPE_PATH_PARAMS = new Set(["appId", "environmentId", "targetEnvironmentId"]);

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
 */
export function missingRequiredPositional(
  command: CliCommandDefinition,
  invocation: ParsedInvocation,
): string | undefined {
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

/**
 * When argv has more tokens than unfilled path slots, a param was supplied twice
 * (`--org` / `--body-json` plus a positional). Returns that param's display name.
 */
export function conflictingSuppliedPositional(
  command: CliCommandDefinition,
  invocation: ParsedInvocation,
): string | undefined {
  const specs = requiredPositionalSpecs(command);
  const body = parseBodyJsonRecord(invocation.flags.bodyJson);
  const unfilledCount = specs.filter(
    (spec) => !pathParamAlreadyFilled(spec.param, invocation.flags.org, body),
  ).length;
  if (invocation.positionals.length <= unfilledCount) {
    return undefined;
  }
  return (
    specs.find((spec) => pathParamAlreadyFilled(spec.param, invocation.flags.org, body))?.display ??
    specs[0]?.display
  );
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

/** Parse `--body-json` into a record when present and well-formed; else undefined. */
function parseBodyJsonRecord(bodyJson: string | undefined): Record<string, unknown> | undefined {
  if (!bodyJson) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(bodyJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid JSON is a later usage/parse failure; do not mask it here.
  }
  return undefined;
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

export function conflictingPositionalError(display: string): SplitchCliError {
  return new SplitchCliError({
    code: "CLI_USAGE_INVALID",
    causeSummary: `<${display}> was supplied more than once`,
    remediation: `Pass <${display}> only once (positional or via --org / --body-json)`,
  });
}
