import { KILL_SWITCH_OFF_EXEMPTION } from "@splitch/sdk/control-plane";
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
  if (command.kind === "flag_targeting_rules_add") {
    return [
      "Builds one equality Targeting Rule (id, Variant name, schema) and appends it via flag-targeting-rules replace.",
      "Repeat --when to AND Conditions. For Segments, non-equality operators, OR groups, reordering, or removal, use flag-targeting-rules replace.",
      "Read-modify-write is last-write-wins: a concurrent replace can overwrite this append. The replace endpoint has no version guard.",
      "While a Run is live on this Flag, the write is refused with RUN_FROZEN (end the Run first).",
    ];
  }
  if (command.operationId === "flag_targeting_rules_replace") {
    return [
      "Raw full-replace of this Environment's ordered Targeting Rule list. For the common equality case, use flag-targeting-rules add --when attr=value --serve <variant>.",
      "Read-modify-write is last-write-wins: send the complete list, or a concurrent writer drops rules you omitted. The replace endpoint has no version guard.",
      "While a Run is live on this Flag, replace is refused with RUN_FROZEN (end the Run first).",
      "A live Run evaluates its own frozen Targeting Rule snapshot, not this Flag Configuration list.",
    ];
  }
  if (command.operationId === "flags_delete" || command.operationId === "flag_variants_delete") {
    return deleteWithoutConfirmNotes();
  }
  return [];
}

/**
 * DELETE carries no body, so --confirm cannot send an inline review. Silence
 * used to read as an oversight (SPL-455); name the two-step path instead.
 * Invocations are the registered command paths and flags — not invented ones.
 */
function deleteWithoutConfirmNotes(): string[] {
  return [
    "This DELETE route does not accept --confirm (DELETE carries no request body).",
    "Review a pending Approval Request, then apply it:",
    "splitch approval-requests list",
    'splitch approval-request-reviews create <id> --body-json \'{"action":"approve_and_apply"}\'',
  ];
}
