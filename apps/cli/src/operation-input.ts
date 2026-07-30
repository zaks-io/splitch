import { randomUUID } from "node:crypto";
import { getRoute } from "@splitch/contracts";
import type { EvaluateContext } from "@splitch/sdk";
import type { CliCommandDefinition } from "./command-registry.js";
import type { ResolvedContext } from "./context.js";
import {
  applyFlagsCreateConvenienceFields,
  assertContractValidFlagsCreateInput,
} from "./flag-create-input.js";
import type { ParsedGlobalFlags, ParsedInvocation } from "./parse-args.js";

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
  applyCommandSpecificFields(command, invocation, input);
  applyExplicitIdempotencyKey(invocation.flags, input);
  applyRequiredIdempotencyKey(command, input);
  return input;
}

function applyExplicitIdempotencyKey(
  flags: ParsedGlobalFlags,
  input: Record<string, unknown>,
): void {
  if (flags.idempotencyKey) {
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
  if (command.needsApp && context.appId) {
    input.appId = context.appId;
  }
  if (command.needsEnvironment && context.environmentId) {
    if (command.operationId === "flags_promote") {
      input.targetEnvironmentId = context.environmentId;
    } else {
      input.environmentId = context.environmentId;
    }
  }
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
  const route = getRoute(command.operationId);
  const pathParams = route ? [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]) : [];
  let positionalIndex = 0;
  for (const param of pathParams) {
    if (
      !param ||
      param === "appId" ||
      param === "environmentId" ||
      param === "targetEnvironmentId"
    ) {
      continue;
    }
    if (positionalIndex < invocation.positionals.length) {
      input[param] = invocation.positionals[positionalIndex];
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
  if (command.supportsConfirm && flags.confirm) {
    input.review = { action: "approve_and_apply" };
  }
}

function applyRequiredIdempotencyKey(
  command: CliCommandDefinition,
  input: Record<string, unknown>,
): void {
  const route = getRoute(command.operationId);
  if (route?.idempotency === "required" && typeof input.idempotency_key !== "string") {
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
      invocation.flags.contextJson,
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
  contextJson: string | undefined,
): EvaluateContext {
  if (!targetingKey) {
    throw new Error("splitch flags test-eval requires --targeting-key");
  }
  const base = contextJson
    ? (JSON.parse(contextJson) as Record<string, unknown>)
    : { attributes: {} };
  return {
    targetingKey,
    idType: typeof base.idType === "string" ? base.idType : "user",
    attributes:
      base.attributes && typeof base.attributes === "object"
        ? (base.attributes as EvaluateContext["attributes"])
        : {},
  };
}
