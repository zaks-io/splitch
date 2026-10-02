import {
  HydratedFlagListResponseSchema,
  HydratedFlagResponseSchema,
  HydratedPrincipalFlagListResponseSchema,
} from "@splitch/contracts";

/**
 * `summary` is the compact-response opt-out, so pairing it with a hydration
 * field is a contradiction the caller controls. It reaches the agent as the
 * same typed `VALIDATION_ERROR` tool result the idempotency rule uses, naming
 * the field to drop (SPL-266, ADR-0036).
 */
export class McpFlagReadUsageError extends Error {
  readonly errorResponse: {
    code: "VALIDATION_ERROR";
    message: string;
    details: { issues: Array<{ path: string[]; message: string }> };
  };

  constructor(operationId: string, conflictingField: string) {
    const detail = `${operationId} cannot combine summary with ${conflictingField}: drop ${conflictingField} for the compact response, or drop summary for complete Flag Configurations`;
    super(detail);
    this.name = "McpFlagReadUsageError";
    this.errorResponse = {
      code: "VALIDATION_ERROR",
      message: detail,
      details: { issues: [{ path: [conflictingField], message: "conflicts with summary" }] },
    };
  }
}

export class McpFlagReadContractError extends Error {
  readonly errorResponse: {
    code: "INTERNAL_SERVER_ERROR";
    message: string;
    remediation: string;
    recommendedAction: string;
    docsUrl: string;
    details: { fault: string };
  };

  constructor(operationId: string) {
    const message = `${operationId} requested complete Flag Configurations but received an unhydrated response`;
    super(message);
    this.name = "McpFlagReadContractError";
    this.errorResponse = {
      code: "INTERNAL_SERVER_ERROR",
      message,
      remediation:
        "Update the server to the SPL-529 Flag-read contract or report the response mismatch",
      recommendedAction: "UPDATE_SERVER",
      docsUrl: "https://splitch.dev/docs/error/INTERNAL_SERVER_ERROR",
      details: { fault: "FLAG_READ_CONTRACT_MISMATCH" },
    };
  }
}

export function withFlagReadDefaults(
  operationId: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (
    operationId !== "principal_flags_list" &&
    operationId !== "flags_list" &&
    operationId !== "flags_get"
  ) {
    return input;
  }
  const { summary, ...requestInput } = input;
  if (summary === true) {
    const conflict = ["include", "envs"].find((field) => requestInput[field] !== undefined);
    if (conflict) throw new McpFlagReadUsageError(operationId, conflict);
    return requestInput;
  }
  if (requestInput.include !== undefined) return requestInput;
  if (
    operationId === "flags_list" &&
    typeof requestInput.environmentId === "string" &&
    requestInput.envs === undefined
  ) {
    const { environmentId, ...hydratedInput } = requestInput;
    return { ...hydratedInput, include: "config", envs: environmentId };
  }
  return { ...requestInput, include: "config" };
}

export function assertHydratedFlagResult(
  operationId: string,
  input: Record<string, unknown>,
  result: { ok: true; data: unknown } | { ok: false },
): void {
  if (!result.ok || input.include !== "config") return;
  if (isHydratedFlagResult(operationId, result.data)) return;
  throw new McpFlagReadContractError(operationId);
}

function isHydratedFlagResult(operationId: string, payload: unknown): boolean {
  if (operationId === "principal_flags_list") {
    return HydratedPrincipalFlagListResponseSchema.safeParse(payload).success;
  }
  if (operationId === "flags_list") {
    return HydratedFlagListResponseSchema.safeParse(payload).success;
  }
  if (operationId === "flags_get") {
    return HydratedFlagResponseSchema.safeParse(payload).success;
  }
  return true;
}
