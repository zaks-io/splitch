import { KILL_SWITCH_OFF_EXEMPTION } from "@splitch/contracts";
import type { CliCommandDefinition } from "./command-registry.js";

/**
 * Operator-facing freeze announcements that the route summary alone does not
 * make obvious (SPL-307). Keep these short: the CLI also prints a live notice
 * after Start and after a staged Targeting Rule edit under a live Run.
 *
 * Wire field names belong here once (payload landmarks), not in route summaries
 * or MCP tool descriptions.
 */
export function operationBehaviorNotes(command: CliCommandDefinition): string[] {
  if (command.kind === "env_policy_get" || command.kind === "env_policy_set") {
    return [KILL_SWITCH_OFF_EXEMPTION];
  }
  if (command.operationId === "experiments_start") {
    return [
      "Start freezes the Experiment draft Targeting Rules into the new Run; the response field frozenTargetingRules is that snapshot (same as run.targetingRules).",
      "An empty frozen set means all Entities are eligible via allocation; Flag Configuration targeting rules do not apply while the Run is live.",
      "Without --json, the CLI prints a frozen-targeting summary to stderr.",
    ];
  }
  if (command.operationId === "experiments_update") {
    return [
      "While a Run is live, assignment fields (including Targeting Rules) require stageForNextRun and write only the next-Run draft.",
      "A successful staged Targeting Rule edit returns liveRunUnaffected naming the Run evaluation still uses.",
      "Without --json, the CLI prints that the live Run is unaffected.",
    ];
  }
  if (command.operationId === "flag_targeting_rules_replace") {
    return [
      "While a Run is live on this Flag, replace is refused with RUN_FROZEN (end the Run first).",
      "A live Run evaluates its own frozen Targeting Rule snapshot, not this Flag Configuration list.",
    ];
  }
  return [];
}
