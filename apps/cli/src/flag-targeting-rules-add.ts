import { randomUUID } from "node:crypto";
import {
  type ErrorResponse,
  type Flag,
  type TargetingRule,
  TargetingRuleSchema,
} from "@splitch/sdk/control-plane";
import { withAuthorizationRetry } from "./auth.js";
import type { CliCommandDefinition } from "./command-registry.js";
import type { ResolvedContext } from "./context.js";
import { SplitchCliError, writeCliError } from "./errors.js";
import { executeApiOperation, handleExecutionError } from "./execute-operations.js";
import type { CliDeps, CliIo, CliResult } from "./execute-types.js";
import { EXIT_USAGE } from "./exit-codes.js";
import { CliInputError } from "./flag-create-input.js";
import {
  buildAppendedTargetingRule,
  type FlagTargetingRulesAddInput,
  parseFlagTargetingRulesAddInput,
  resolveVariantByName,
} from "./flag-targeting-rules-add-input.js";
import { environmentSelectorOverride } from "./operation-input.js";
import type { ParsedInvocation } from "./parse-args.js";
import { createOperationSdks } from "./sdks.js";
import { exitCodeForServerError, writeServerError } from "./server-errors.js";

export async function executeFlagTargetingRulesAdd(
  command: CliCommandDefinition,
  invocation: ParsedInvocation,
  deps: CliDeps,
  io: CliIo,
  context: ResolvedContext,
): Promise<CliResult> {
  const parsed = parseAddInputResult(invocation, io);
  if ("exitCode" in parsed) return parsed;
  const scoped = requireAddScope(invocation, context, io);
  if ("exitCode" in scoped) return scoped;
  try {
    const input = await assembleReplaceInput({
      addInput: parsed.addInput,
      command,
      invocation,
      deps,
      io,
      scope: scoped,
    });
    if ("exitCode" in input) return input;
    return executeApiOperation("flag_targeting_rules_replace", input.body, invocation, deps, io);
  } catch (error) {
    return writeAddError(error, io);
  }
}

function parseAddInputResult(
  invocation: ParsedInvocation,
  io: CliIo,
): { addInput: FlagTargetingRulesAddInput } | CliResult {
  try {
    return { addInput: parseFlagTargetingRulesAddInput(invocation) };
  } catch (error) {
    return writeAddError(error, io);
  }
}

function requireAddScope(
  invocation: ParsedInvocation,
  context: ResolvedContext,
  io: CliIo,
): { flagSelector: string; appId: string; environmentId: string; by?: string } | CliResult {
  const flagSelector = invocation.positionals[0];
  if (!flagSelector || !context.appId || !context.environmentId) {
    writeCliError(io, {
      code: "CLI_USAGE_INVALID",
      causeSummary:
        "flag-targeting-rules add requires <flag-id-or-key> and a selected App/Environment",
      remediation: "Pass the Flag ID or key, and select scope with splitch use or --app / --env",
    });
    return { exitCode: EXIT_USAGE };
  }
  return {
    flagSelector,
    appId: context.appId,
    environmentId: context.environmentId,
    ...environmentSelectorOverride(invocation.flags.by),
  };
}

async function assembleReplaceInput(options: {
  readonly addInput: FlagTargetingRulesAddInput;
  readonly command: CliCommandDefinition;
  readonly invocation: ParsedInvocation;
  readonly deps: CliDeps;
  readonly io: CliIo;
  readonly scope: { flagSelector: string; appId: string; environmentId: string; by?: string };
}): Promise<{ body: Record<string, unknown> } | CliResult> {
  const { addInput, command, invocation, deps, io, scope } = options;
  const catalog = await readFlagBySelector(deps, io, invocation, scope.appId, scope.flagSelector);
  if ("exitCode" in catalog) return catalog;
  const variant = resolveVariantByName(catalog.flag.variants, addInput.variantName);
  const existing = await readRulesForAdd(deps, io, invocation, scope, scope.flagSelector);
  if ("exitCode" in existing) return existing;
  const appended = buildAppendedTargetingRule({
    flagId: catalog.flag.id,
    existing: existing.rules,
    conditions: addInput.conditions,
    variantId: variant.id,
  });
  const body: Record<string, unknown> = {
    appId: scope.appId,
    environmentId: scope.environmentId,
    ...environmentSelectorOverride(scope.by),
    flagId: scope.flagSelector,
    targetingRules: [...existing.rules, appended],
    idempotency_key: invocation.flags.idempotencyKey ?? `cli_${randomUUID()}`,
  };
  if (command.supportsConfirm && invocation.flags.confirm) {
    body.review = { action: "approve_and_apply" };
  }
  return { body };
}

async function readFlagBySelector(
  deps: CliDeps,
  io: CliIo,
  invocation: ParsedInvocation,
  appId: string,
  flagId: string,
): Promise<{ flag: Flag } | CliResult> {
  const flagResult = await readControlPlane(deps, "flags_get", { appId, flagId });
  if (!flagResult.ok) {
    writeServerError(io, flagResult.error, "flags_get", invocation);
    return { exitCode: exitCodeForServerError(flagResult.error), payload: flagResult.error };
  }
  return { flag: readFlagCatalog(flagResult.data) };
}

async function readRulesForAdd(
  deps: CliDeps,
  io: CliIo,
  invocation: ParsedInvocation,
  scope: { appId: string; environmentId: string; by?: string },
  flagId: string,
): Promise<{ rules: TargetingRule[] } | CliResult> {
  const configResult = await readControlPlane(deps, "flag_config_get", {
    appId: scope.appId,
    environmentId: scope.environmentId,
    flagId,
    ...environmentSelectorOverride(scope.by),
  });
  if (!configResult.ok) {
    writeServerError(io, configResult.error, "flag_config_get", invocation);
    return { exitCode: exitCodeForServerError(configResult.error), payload: configResult.error };
  }
  return { rules: readExistingRules(configResult.data) };
}

function writeAddError(error: unknown, io: CliIo): CliResult {
  if (error instanceof CliInputError) {
    writeCliError(io, error);
    return { exitCode: EXIT_USAGE, payload: error.payload };
  }
  return handleExecutionError(error, io);
}

function readFlagCatalog(data: unknown): Flag {
  if (!data || typeof data !== "object" || !("variants" in data) || !Array.isArray(data.variants)) {
    throw new SplitchCliError({
      code: "CLI_UNEXPECTED_ERROR",
      causeSummary: "flags_get returned a Flag without a Variant catalog",
      remediation: "Retry the command and report the flags_get response shape if it persists",
    });
  }
  return data as Flag;
}

function readExistingRules(data: unknown): TargetingRule[] {
  if (
    !data ||
    typeof data !== "object" ||
    !("targetingRules" in data) ||
    !Array.isArray((data as { targetingRules: unknown }).targetingRules)
  ) {
    throw new SplitchCliError({
      code: "CLI_UNEXPECTED_ERROR",
      causeSummary: "flag_config_get returned Flag Configuration without targetingRules",
      remediation: "Retry the command and report the flag_config_get response shape if it persists",
    });
  }
  const rules: TargetingRule[] = [];
  for (const [index, candidate] of (
    data as { targetingRules: readonly unknown[] }
  ).targetingRules.entries()) {
    const parsed = TargetingRuleSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new SplitchCliError({
        code: "CLI_UNEXPECTED_ERROR",
        causeSummary: `flag_config_get returned an invalid Targeting Rule at index ${index}`,
        remediation:
          "Inspect the Flag Configuration and use flag-targeting-rules replace only with valid rules",
      });
    }
    rules.push(parsed.data);
  }
  return rules;
}

async function readControlPlane(
  deps: CliDeps,
  operationId: string,
  input: Record<string, unknown>,
): Promise<{ ok: true; data: unknown } | { ok: false; error: ErrorResponse }> {
  const payload = await withAuthorizationRetry(
    deps,
    async (authorization) => {
      const result = await createOperationSdks(deps)["control-plane-api"].callOperationById(
        operationId,
        input,
        { authorization },
      );
      return { status: result.ok ? 200 : result.status, value: result };
    },
    typeof input.appId === "string" && input.appId
      ? { kind: "app", selector: input.appId }
      : undefined,
  );
  if (!payload.ok) {
    return { ok: false, error: payload.error };
  }
  return { ok: true, data: payload.data };
}
