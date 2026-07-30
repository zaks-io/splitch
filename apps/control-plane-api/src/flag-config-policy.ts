import {
  type EnvironmentPolicy,
  EnvironmentPolicySchema,
  type PolicyChangeType,
} from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import type { ConfigStoreWriter } from "./config-store";

type PromotionSelect = Parameters<ConfigStoreWriter["promoteFlagConfig"]>[0]["select"];
type HandlerFn = (args: HandlerArgs<unknown>) => Promise<Response>;

/**
 * A stored `environments.policy` that the Environment write API would reject.
 * It fails the read closed (no mutation can proceed), and carries enough
 * identity to diagnose which row violates the contract instead of surfacing as
 * an anonymous runtime fault (ADR-0036).
 */
class EnvironmentPolicyContractError extends Error {
  readonly appId: string;
  readonly environmentId: string;
  readonly issues: string[];

  constructor(appId: string, environmentId: string, issues: string[]) {
    super(
      `environments.policy for ${environmentId} in ${appId} is out of contract: ${issues.join(", ")}`,
    );
    this.name = "EnvironmentPolicyContractError";
    this.appId = appId;
    this.environmentId = environmentId;
    this.issues = issues;
  }
}

/**
 * Run a handler body so an out-of-contract stored Policy still fails closed —
 * no mutation can have happened, the read threw before any write — but arrives
 * as a named contract fault instead of an anonymous "unhandled runtime fault"
 * 500 that gives an operator nothing to act on (ADR-0036).
 */
async function diagnosableContractFaults(
  requestId: string,
  body: () => Promise<Response>,
): Promise<Response> {
  try {
    return await body();
  } catch (cause) {
    if (!(cause instanceof EnvironmentPolicyContractError)) throw cause;
    return renderError(
      {
        code: "INTERNAL_SERVER_ERROR",
        message: `stored Environment Policy is out of contract: ${cause.issues.join(", ")}`,
        details: {},
      },
      { requestId },
    );
  }
}

/**
 * Wrap a whole handler table rather than individual call sites. Every gated
 * mutation reads an Environment Policy, so per-call-site wrapping is guaranteed
 * to drift: a route added later reads as covered while it still answers the
 * anonymous "unhandled runtime fault" 500 the wrapper exists to eliminate.
 */
export function diagnosableHandlers<T extends Record<string, HandlerFn>>(handlers: T): T {
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      (args: HandlerArgs<unknown>) =>
        diagnosableContractFaults(args.requestId, () => handler(args)),
    ]),
  ) as unknown as T;
}

export async function readEnvironmentPolicy(
  repo: Repository,
  appId: string,
  environmentId: string,
): Promise<EnvironmentPolicy | null> {
  const row = await repo.identity.getEnvironment(appScope(appId), environmentId);
  if (!row) return null;
  const parsed = EnvironmentPolicySchema.safeParse(JSON.parse(row.policy));
  if (!parsed.success) {
    throw new EnvironmentPolicyContractError(
      appId,
      environmentId,
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    );
  }
  return parsed.data;
}

export function flagConfigPatchGates(payload: Record<string, unknown>): PolicyChangeType[] {
  const gates: PolicyChangeType[] = [];
  if (payload.availableVariantNames !== undefined) gates.push("variant_availability");
  // The baseline rollout is a rollout VALUE, so it falls under the same gate the
  // per-rule rollout does — a prod percentage change is not a free action.
  if (payload.rollout !== undefined) gates.push("targeting_rollout_value");
  if (payload.enabled === true) gates.push("enabled_state");
  return gates;
}

export function promotionGates(
  select: PromotionSelect,
  sourceEnabled: boolean,
): PolicyChangeType[] {
  const gates: PolicyChangeType[] = [];
  if (select.availability !== undefined) gates.push("variant_availability");
  if (select.targeting || select.rollout) gates.push("targeting_rollout_value");
  if (select.enabled && sourceEnabled) gates.push("enabled_state");
  return gates;
}

export function policyLevel(policy: EnvironmentPolicy, gate: PolicyChangeType) {
  switch (gate) {
    case "variant_availability":
      return policy.variantAvailability;
    case "targeting_rollout_value":
      return policy.targetingRolloutValue;
    case "enabled_state":
      return policy.enabledState;
    case "start_experiment_run":
      return policy.startExperimentRun;
  }
}
