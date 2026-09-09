import {
  APP_ID,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  RUN_ID,
  runRow,
  WATERMARK,
} from "./experiment-conclusion-handler-test-fixtures";
import { statsOutput } from "./panel-experiments-test-fixtures";

export function conclusionRow(requestHash: string) {
  return {
    id: "con_01J00000000000000000000000",
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    experimentId: EXPERIMENT_ID,
    runId: RUN_ID,
    selectedVariant: "treatment",
    configHash: runRow("running").configHash,
    resultToken: `sha256:${"e".repeat(64)}`,
    dataWatermark: WATERMARK,
    resultSnapshot: JSON.stringify(statsOutput()),
    decisionFailures: "[]",
    decisionChecks: "[]",
    targetEnvironmentId: ENVIRONMENT_ID,
    targetFlagId: "flag_conclusion",
    targetConfigVersion: 1,
    proposedFlagConfiguration: JSON.stringify({ enabled: true }),
    reason: null,
    concludedBy: "user_conclusion",
    concludedVia: "device_flow",
    concludedAt: "2026-09-08T18:02:00.000Z",
    idempotencyKey: "test-key",
    requestHash,
  };
}

export function approvalRow() {
  return {
    id: "apr_01J00000000000000000000000",
    appId: APP_ID,
    operation: "experiment_winner_promote",
    targetType: "flag_configuration",
    targetId: "flag_config_conclusion",
    targetVersion: `sha256:${"d".repeat(64)}`,
    policyContexts: JSON.stringify([
      { environmentId: ENVIRONMENT_ID, changeTypes: ["enabled_state"], level: "confirm" },
    ]),
    diff: JSON.stringify({
      current: { enabled: false },
      proposed: { enabled: true },
      entries: [{ path: "/enabled", operation: "replace", current: false, proposed: true }],
    }),
    status: "pending",
    proposedBy: "user_conclusion",
    proposedVia: "device_flow",
    proposedAt: "2026-09-08T18:02:00.000Z",
    resolvedAt: null,
    resultingTargetVersion: null,
    resultingResourceType: null,
    resultingResourceId: null,
    idempotencyKey: "test-key",
    requestHash: `sha256:${"b".repeat(64)}`,
  };
}
