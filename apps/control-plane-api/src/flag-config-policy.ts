import {
  type EnvironmentPolicy,
  EnvironmentPolicySchema,
  type PolicyChangeType,
} from "@splitch/contracts";
import { appScope, type Repository } from "@splitch/db";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import type { ConfigStoreWriter } from "./config-store";
import { takeEnvironmentPolicyGateCacheMiss } from "./environment-policy-gate-cache";

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

/**
 * Authoritative Environment Policy read for the approval gate (SPL-292).
 *
 * Read path: `repo.identity.getEnvironment` → `environments.policy` (D1). There
 * is no KV or read-through isolate cache on this seam. Any seeded isolate-local
 * entry is dropped before the D1 read so a stale cache cannot bypass
 * `confirm` after an Environment Policy write has acked.
 *
 * Fail closed: out-of-contract JSON throws `EnvironmentPolicyContractError`,
 * which `diagnosableHandlers` maps to a named fault — never treated as `allow`.
 */
export async function readEnvironmentPolicy(
  repo: Repository,
  appId: string,
  environmentId: string,
): Promise<EnvironmentPolicy | null> {
  // Drop isolate-local seed/cache before the D1 read (read-your-writes).
  takeEnvironmentPolicyGateCacheMiss(appId, environmentId);
  const row = await repo.identity.getEnvironment(appScope(appId), environmentId);
  if (!row) return null;
  const parsed = EnvironmentPolicySchema.safeParse(
    parsePolicyJson(appId, environmentId, row.policy),
  );
  if (!parsed.success) {
    throw new EnvironmentPolicyContractError(
      appId,
      environmentId,
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    );
  }
  return parsed.data;
}

/**
 * Non-JSON is the same class of fault as JSON that misses the schema: the
 * stored row is out of contract. Both arrive as the one named fault so neither
 * escapes as the anonymous runtime 500 (ADR-0036).
 */
function parsePolicyJson(appId: string, environmentId: string, policy: string): unknown {
  try {
    return JSON.parse(policy);
  } catch (cause) {
    throw new EnvironmentPolicyContractError(appId, environmentId, [
      `<root>: not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
    ]);
  }
}

export function flagConfigPatchGates(payload: Record<string, unknown>): PolicyChangeType[] {
  const gates: PolicyChangeType[] = [];
  if (payload.availableVariantNames !== undefined) gates.push("variant_availability");
  // The baseline rollout is a rollout VALUE, so it falls under the same gate the
  // per-rule rollout does — a prod percentage change is not a free action.
  if (payload.rollout !== undefined) gates.push("targeting_rollout_value");
  // Kill-switch-off is never gated (ADR-0029): `enabled: false` does not push
  // `enabled_state`, so a confirm Policy cannot block turning a Flag off. A
  // cold-agent observation of `--enabled false` applying with
  // `approvalRequest: null` under all-confirm is this exemption, not a stale
  // Policy read (SPL-292).
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
