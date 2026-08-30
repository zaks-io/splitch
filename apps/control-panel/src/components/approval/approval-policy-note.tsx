import { Badge } from "@splitch/ui/components/badge";
import type { ApprovalGatePolicyContext } from "#lib/approval/approval-gate-record";

const CHANGE_TYPE_LABELS: Record<string, string> = {
  variant_availability: "Variant availability",
  targeting_rollout_value: "Targeting and rollout values",
  enabled_state: "Turning the Flag on",
  start_experiment_run: "Starting an Experiment Run",
};

/**
 * Why this change needed confirming, in the Worker's own words.
 *
 * The Policy context is read off the Approval Request, never recomputed here. A
 * panel that re-derived the gate from a policy it fetched separately could tell
 * the operator a different story than the one the Worker enforced (ADR-0023).
 */
export function ApprovalPolicyNote({
  policyContexts,
}: {
  policyContexts: readonly ApprovalGatePolicyContext[];
}) {
  return (
    <div className="grid gap-2" data-approval-policy="true">
      {policyContexts.map((context) => (
        <p
          className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm leading-6"
          key={`${context.environmentId}:${context.level}`}
        >
          <Badge variant="outline" className="font-mono text-[0.65rem] uppercase tracking-[0.14em]">
            {context.level}
          </Badge>
          <span>
            The Environment Policy gates{" "}
            {context.changeTypes
              .map((changeType) => CHANGE_TYPE_LABELS[changeType] ?? changeType)
              .join(", ")}{" "}
            here.
          </span>
        </p>
      ))}
    </div>
  );
}
