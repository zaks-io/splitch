import { randomUUID } from "node:crypto";
import type { EvaluateContext } from "@splitch/sdk";
import { deriveMcpTools, getRoute } from "@splitch/sdk/control-plane";
import { excessPositionalError, requiredPositionalSpecs } from "./command-positionals.js";
import type { CliCommandDefinition } from "./command-registry.js";
import type { ResolvedContext } from "./context.js";
import { SplitchCliError } from "./errors.js";
import {
  applyFlagsCreateConvenienceFields,
  assertContractValidFlagsCreateInput,
} from "./flag-create-input.js";
import type { ParsedGlobalFlags, ParsedInvocation } from "./parse-args.js";

const TOOL_BY_OPERATION = new Map(deriveMcpTools().map((tool) => [tool.name, tool]));

/** True when the operation's flat input schema accepts an `environmentId` field. */
function operationInputHasEnvironmentId(operationId: string): boolean {
  const schema = TOOL_BY_OPERATION.get(operationId)?.inputSchema;
  if (!schema || !("shape" in schema)) return false;
  return "environmentId" in (schema.shape as Record<string, unknown>);
}

export function environmentSelectorOverride(by: string | undefined): { by?: string } {
  return by === undefined ? {} : { by };
}

export function buildOperationInput(
  command: CliCommandDefinition,
  invocation: ParsedInvocation,
  context: ResolvedContext,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  applyBodyJson(invocation.flags, input);
  applyContextFields(command, context, input);
  applyOrgFlag(invocation.flags, input);
  applyPositionalFields(command, invocation, input);
  applyNamedFlags(command, invocation.flags, input);
  // The Idempotency Key is minted before the command-specific step because that
  // step validates the assembled input against the contract.
  applyExplicitIdempotencyKey(invocation.flags, input);
  applyDefaultIdempotencyKey(command, input);
  applyCommandSpecificFields(command, invocation, input);
  applyFlagReadFields(command, invocation, context, input);
  return input;
}

function applyExplicitIdempotencyKey(
  flags: ParsedGlobalFlags,
  input: Record<string, unknown>,
): void {
  if (flags.idempotencyKey !== undefined) {
    input.idempotency_key = flags.idempotencyKey;
  }
}

function applyBodyJson(flags: ParsedGlobalFlags, input: Record<string, unknown>): void {
  if (flags.bodyJson) {
    Object.assign(input, JSON.parse(flags.bodyJson) as Record<string, unknown>);
  }
}

function applyContextFields(
  command: CliCommandDefinition,
  context: ResolvedContext,
  input: Record<string, unknown>,
): void {
  if (context.appId && usesAppContext(command)) {
    input.appId = context.appId;
  }
  if (!context.environmentId) {
    return;
  }
  if (command.needsEnvironment) {
    if (command.operationId === "flags_promote") {
      input.targetEnvironmentId = context.environmentId;
    } else {
      input.environmentId = context.environmentId;
    }
    return;
  }
  if (command.operationId === "flags_list") {
    return;
  }
  // Optional Environment filters (e.g. approval_requests_list) are opt-in via
  // `--env` only. Config / SPLITCH_ENV must not silently narrow an App-scoped
  // list — unfiltered means the full App set (SPL-294).
  if (context.environmentSource === "flag" && operationInputHasEnvironmentId(command.operationId)) {
    input.environmentId = context.environmentId;
  }
}

function usesAppContext(command: CliCommandDefinition): boolean {
  return command.needsApp || command.alternateOperationIds?.includes("flags_list") === true;
}

function applyOrgFlag(flags: ParsedGlobalFlags, input: Record<string, unknown>): void {
  if (flags.org) {
    input.orgId = flags.org;
  }
}

function applyPositionalFields(
  command: CliCommandDefinition,
  invocation: ParsedInvocation,
  input: Record<string, unknown>,
): void {
  // Same rule as missingRequiredPositional: argv fills only slots still empty
  // after --body-json / --org. Excess argv means a param was supplied twice —
  // fail loud rather than sliding tokens into the wrong slots (ADR-0036).
  const specs = requiredPositionalSpecs(command);
  const alreadyFilled = (param: string): boolean => {
    const existing = input[param];
    return typeof existing === "string" && existing.length > 0;
  };
  const unfilled = specs.filter((spec) => !alreadyFilled(spec.param));
  if (invocation.positionals.length > unfilled.length) {
    const conflict = specs.find((spec) => alreadyFilled(spec.param));
    if (conflict) {
      throw excessPositionalError({ kind: "conflict", display: conflict.display });
    }
    const token = invocation.positionals[unfilled.length] ?? "";
    throw excessPositionalError({ kind: "unexpected", token });
  }
  let positionalIndex = 0;
  for (const spec of unfilled) {
    const token = invocation.positionals[positionalIndex];
    if (token) {
      input[spec.param] = token;
      positionalIndex += 1;
    }
  }
}

function applyNamedFlags(
  command: CliCommandDefinition,
  flags: ParsedGlobalFlags,
  input: Record<string, unknown>,
): void {
  if (flags.name) {
    input.name = flags.name;
  }
  if (flags.key) {
    input.key = flags.key;
  }
  applyByFlag(command, flags.by, input);
  if (command.supportsConfirm && flags.confirm) {
    input.review = { action: "approve_and_apply" };
  }
  if (supportsDeleteMode(command.operationId)) {
    if (flags.dryRun) input.dryRun = true;
    if (flags.force) input.force = true;
  }
}

function applyByFlag(
  command: CliCommandDefinition,
  by: string | undefined,
  input: Record<string, unknown>,
): void {
  if (!by) return;
  const querySchema = getRoute(command.operationId)?.openapi.request?.query;
  const queryShape = (querySchema as { shape?: unknown } | undefined)?.shape;
  if (!queryShape || typeof queryShape !== "object" || !Object.hasOwn(queryShape, "by")) {
    throw new SplitchCliError({
      code: "CLI_USAGE_INVALID",
      causeSummary: `--by is not accepted by splitch ${command.path.join(" ")}`,
      remediation: `Drop --by, or run splitch ${command.path.join(" ")} --help to list the accepted flags`,
    });
  }
  input.by = by;
}

function supportsDeleteMode(operationId: string): boolean {
  // organizations_delete adopts the same query shape when implemented; until
  // then only apps_delete accepts dryRun/force (SPL-326).
  return operationId === "apps_delete";
}

function applyDefaultIdempotencyKey(
  command: CliCommandDefinition,
  input: Record<string, unknown>,
): void {
  const route = getRoute(command.operationId);
  if (route && route.idempotency !== "none" && !Object.hasOwn(input, "idempotency_key")) {
    input.idempotency_key = `cli_${randomUUID()}`;
  }
}

function applyCommandSpecificFields(
  command: CliCommandDefinition,
  invocation: ParsedInvocation,
  input: Record<string, unknown>,
): void {
  if (command.operationId === "flags_promote" && invocation.flags.fromEnvironmentId) {
    input.fromEnvironmentId = invocation.flags.fromEnvironmentId;
    input.select = input.select ?? { enabled: true };
  }
  if (command.operationId === "flag_config_update") {
    applyFlagConfigUpdateFields(invocation.flags, input);
  }
  if (command.operationId === "flags_test_eval") {
    input.evaluationContext = parseEvaluationContext(
      invocation.flags.targetingKey,
      invocation.flags.idType,
      invocation.flags.contextJson,
      input.evaluationContext,
    );
  }
  if (command.operationId === "flags_create") {
    applyFlagsCreateConvenienceFields(input, {
      key: invocation.flags.key,
      name: invocation.flags.name,
      variants: invocation.flags.variants,
    });
    assertContractValidFlagsCreateInput(input);
  }
}

function applyFlagReadFields(
  command: CliCommandDefinition,
  invocation: ParsedInvocation,
  context: ResolvedContext,
  input: Record<string, unknown>,
): void {
  if (
    command.operationId !== "principal_flags_list" &&
    command.operationId !== "flags_list" &&
    command.operationId !== "flags_get"
  ) {
    return;
  }
  if (invocation.flags.summary) {
    if (command.operationId === "flags_list" && invocation.flags.env) {
      input.environmentId = context.environmentId;
    }
    return;
  }
  input.include = "config";
  if (invocation.flags.env) {
    input.envs = context.environmentId;
  }
}

function applyFlagConfigUpdateFields(
  flags: ParsedGlobalFlags,
  input: Record<string, unknown>,
): void {
  if (flags.enabled !== undefined) {
    input.enabled = flags.enabled;
  }
  if (flags.rollout !== undefined) {
    // Percentage only; the salt is the server's to mint and preserve, so there is
    // deliberately no CLI surface for it.
    input.rollout = flags.rollout === null ? null : { percentage: flags.rollout };
  }
}

export function parseEvaluationContext(
  targetingKey: string | undefined,
  idType: string | undefined,
  contextJson: string | undefined,
  bodyEvaluationContext?: unknown,
): EvaluateContext {
  const base = evaluationContextSource(contextJson, bodyEvaluationContext);
  const resolvedTargetingKey = targetingKey ?? base.targetingKey;
  if (typeof resolvedTargetingKey !== "string" || !resolvedTargetingKey) {
    throw new SplitchCliError({
      code: "CLI_USAGE_INVALID",
      causeSummary: "flags test-eval requires an Entity Targeting Key",
      remediation:
        "Pass it with --targeting-key or as evaluationContext.targetingKey in --body-json",
    });
  }
  const resolvedIdType = idType ?? base.idType ?? "user";
  if (typeof resolvedIdType !== "string" || !resolvedIdType) {
    throw new SplitchCliError({
      code: "CLI_USAGE_INVALID",
      causeSummary: "Evaluation Context idType must be a non-empty string",
      remediation: "Pass the Entity identity type with --id-type",
    });
  }
  return {
    targetingKey: resolvedTargetingKey,
    idType: resolvedIdType,
    attributes:
      base.attributes && typeof base.attributes === "object"
        ? (base.attributes as EvaluateContext["attributes"])
        : {},
  };
}

function evaluationContextSource(
  contextJson: string | undefined,
  bodyEvaluationContext: unknown,
): Record<string, unknown> {
  const source = contextJson ? JSON.parse(contextJson) : bodyEvaluationContext;
  if (source === undefined) return { attributes: {} };
  if (source && typeof source === "object" && !Array.isArray(source)) {
    return source as Record<string, unknown>;
  }
  throw new SplitchCliError({
    code: "CLI_USAGE_INVALID",
    causeSummary: "Evaluation Context must be a JSON object",
    remediation: "Pass an object with --context-json or as evaluationContext in --body-json",
  });
}
