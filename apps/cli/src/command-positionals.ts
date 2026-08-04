import { getRoute } from "@splitch/contracts";
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
 * First required positional that is neither present on argv nor satisfied by a
 * known alternate (`--org` for `org-id`, or a string field in `--body-json`).
 */
export function missingRequiredPositional(
  command: CliCommandDefinition,
  invocation: ParsedInvocation,
): string | undefined {
  const specs = requiredPositionalSpecs(command);
  const body = parseBodyJsonRecord(invocation.flags.bodyJson);
  let positionalIndex = 0;
  for (const spec of specs) {
    const token = invocation.positionals[positionalIndex];
    if (token) {
      positionalIndex += 1;
      continue;
    }
    // Documented `--org` flag fills `:orgId` without a positional (quickstart /
    // mcp-and-cli surfaces teach `apps create --org <orgId>`).
    if (spec.param === "orgId" && invocation.flags.org) {
      continue;
    }
    const fromBody = body?.[spec.param];
    if (typeof fromBody === "string" && fromBody.length > 0) {
      continue;
    }
    return spec.display;
  }
  return undefined;
}

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
    throw missingPositionalError(command, spec.display);
  }
}

export function missingPositionalError(
  command: CliCommandDefinition,
  display: string,
): SplitchCliError {
  const usage = commandUsageLine(command);
  return new SplitchCliError({
    code: "CLI_USAGE_INVALID",
    causeSummary: `Missing required argument <${display}>`,
    remediation: `Pass <${display}>. Usage: ${usage}`,
  });
}
