/**
 * Human-readable notices for operations whose JSON body alone does not make a
 * state transition obvious (SPL-307). Printed to stderr so `--json` stdout stays
 * machine-parseable when the caller asks for it — but when `--json` is off these
 * lines appear without requiring the operator to dig through the payload.
 */

import type { CliIo } from "./execute-types.js";

interface TargetingRuleSummary {
  readonly id?: string;
  readonly priority?: number;
  readonly conditions?: unknown[];
}

export function emitOperationNotices(
  operationId: string,
  payload: unknown,
  asJson: boolean,
  io: CliIo,
): void {
  if (
    operationId === "principal_flags_list" &&
    isObject(payload) &&
    payload.readTruncated === true &&
    !asJson
  ) {
    io.error("Flag list is incomplete. Narrow it with --app <app>.");
    return;
  }
  if (asJson) return;
  if (operationId === "experiments_start") {
    emitStartNotices(payload, io);
    return;
  }
  if (operationId === "experiments_update") {
    emitUpdateNotices(payload, io);
  }
}

function emitStartNotices(payload: unknown, io: CliIo): void {
  if (!isObject(payload) || !isObject(payload.run)) return;
  const runId = typeof payload.run.id === "string" ? payload.run.id : "unknown";
  const rules = targetingRulesFrom(payload.frozenTargetingRules ?? payload.run.targetingRules);
  io.error(formatFrozenTargetingNotice(runId, rules));
}

function emitUpdateNotices(payload: unknown, io: CliIo): void {
  if (!isObject(payload) || !isObject(payload.liveRunUnaffected)) return;
  const runId =
    typeof payload.liveRunUnaffected.runId === "string"
      ? payload.liveRunUnaffected.runId
      : "unknown";
  const frozen = targetingRulesFrom(payload.liveRunUnaffected.frozenTargetingRules);
  io.error(`Live Run ${runId} is unaffected; this edit staged the next-Run draft only.`);
  io.error(formatFrozenTargetingNotice(runId, frozen));
}

export function formatFrozenTargetingNotice(
  runId: string,
  rules: readonly TargetingRuleSummary[],
): string {
  if (rules.length === 0) {
    return (
      `Frozen targeting rules for ${runId}: (none; all Entities eligible via allocation; ` +
      "Flag Configuration targeting rules do not apply while this Run is live)"
    );
  }
  const summary = rules
    .map((rule) => {
      const id = typeof rule.id === "string" ? rule.id : "rule";
      const priority = typeof rule.priority === "number" ? rule.priority : "?";
      const conditions = Array.isArray(rule.conditions) ? rule.conditions.length : 0;
      return `${id}@${priority}(${conditions} condition${conditions === 1 ? "" : "s"})`;
    })
    .join(", ");
  return `Frozen targeting rules for ${runId}: ${summary}`;
}

function targetingRulesFrom(value: unknown): TargetingRuleSummary[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is TargetingRuleSummary => isObject(item));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
