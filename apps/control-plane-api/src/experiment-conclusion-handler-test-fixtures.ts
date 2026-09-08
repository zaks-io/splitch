import { type ConcludeRunRequest, canonicalHash, type StatsOutput } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import type { HandlerArgs, Principal } from "@splitch/worker-runtime";
import { type Mock, vi } from "vitest";
import type { ExperimentDeps } from "./experiment-handler-shared";
export const APP_ID = "app_conclusion";
export const ENVIRONMENT_ID = "env_conclusion";
export const EXPERIMENT_ID = "exp_conclusion";
export const RUN_ID = "run_conclusion";
const FLAG_ID = "flag_conclusion";
const ACTOR_ID = "user_conclusion";
export const WATERMARK = "2026-09-08T18:00:00.000Z";
type AnalysisEnvelope =
  | {
      state: "ready";
      run_id: string;
      control_variant: string;
      data_watermark: string;
      result_token: `sha256:${string}`;
      stats: StatsOutput;
    }
  | {
      state: "no_data";
      run_id: string;
      control_variant: string;
      missing: "run_input" | "exposures" | "metric_values";
    };
interface ConclusionFixture {
  analysis: Mock;
  args: HandlerArgs<unknown>;
  body: ConcludeRunRequest;
  commit: Mock;
  deps: ExperimentDeps;
  readRun: Mock;
  readTargetConfig: Mock;
  repo: Repository;
}
export function conclusionFixture(
  options: {
    membershipRole?: string;
    targetConfigVersion?: number;
    expectedResultToken?: `sha256:${string}`;
    analysisEnvelope?: AnalysisEnvelope;
  } = {},
): ConclusionFixture {
  const commit = vi.fn();
  const readRun = vi.fn(async () => runRow("running"));
  const readTargetConfig = vi.fn(async () => flagConfigRow(options.targetConfigVersion ?? 1));
  const analysis = vi.fn(async () =>
    Response.json(
      options.analysisEnvelope ?? {
        state: "no_data",
        run_id: RUN_ID,
        control_variant: "control",
        missing: "exposures",
      },
    ),
  );
  const repo = {
    identity: {
      getAppMembership: vi.fn(async () => ({ role: options.membershipRole ?? "admin" })),
      getEnvironment: vi.fn(async () => environmentRow()),
    },
    experiments: {
      getRun: readRun,
      getExperiment: vi.fn(async () => experimentRow()),
      findRunningExperimentForFlag: vi.fn(async () => null),
    },
    flags: {
      getFlag: vi.fn(async () => ({ id: FLAG_ID, key: "checkout-flag", version: 1 })),
      getFlagConfig: readTargetConfig,
      getFlagConfigById: vi.fn(async () => flagConfigRow(options.targetConfigVersion ?? 1)),
      listVariantsForFlags: vi.fn(async () => new Map([[FLAG_ID, variantRows()]])),
      listTargetingRules: vi.fn(async () => []),
      listSegmentsByIds: vi.fn(async () => []),
    },
    experimentConclusions: {
      getByActorKey: vi.fn(async () => null),
      get: vi.fn(async () => null),
      listApprovalLinks: vi.fn(async () => []),
      commit,
    },
    approvals: {
      getRequestByActorKey: vi.fn(async () => null),
      getRequest: vi.fn(async () => null),
      latestReview: vi.fn(async () => null),
    },
  } as unknown as Repository;
  const body: ConcludeRunRequest = {
    selectedVariant: "treatment",
    expectedResultToken: options.expectedResultToken ?? `sha256:${"e".repeat(64)}`,
    dataWatermark: WATERMARK,
    target: {
      environmentId: ENVIRONMENT_ID,
      flagId: FLAG_ID,
      expectedConfigVersion: 1,
      proposedConfig: {
        enabled: true,
        availableVariantNames: ["control", "treatment"],
        targetingRules: [],
        rollout: null,
      },
    },
    idempotencyKey: "test-key",
  };
  const deps = {
    repo,
    analysis: { fetch: analysis } as unknown as Fetcher,
    configStore: {
      writerFor: () => ({ syncExperimentConfig: vi.fn(async () => ({ ok: true })) }),
    },
    nowIso: () => "2026-09-08T18:02:00.000Z",
  } as unknown as ExperimentDeps;
  return {
    analysis,
    args: handlerArgs(body),
    body,
    commit,
    deps,
    readRun,
    readTargetConfig,
    repo,
  };
}
function handlerArgs(body: ConcludeRunRequest): HandlerArgs<unknown> {
  return {
    input: {
      params: {
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        experimentId: EXPERIMENT_ID,
        runId: RUN_ID,
      },
      body,
    },
    principal: principal(),
    requestId: "request_conclusion",
    request: new Request("https://control.splitch.dev/conclude", { method: "POST" }),
  };
}
function principal(): Principal {
  return {
    kind: "control-plane-token",
    id: ACTOR_ID,
    scopes: [`app:${APP_ID}:admin`],
    orgId: null,
    appId: APP_ID,
    environmentId: null,
    authDoor: "device_flow",
  };
}
export function runRow(status: "running" | "ended") {
  return {
    id: RUN_ID,
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    experimentId: EXPERIMENT_ID,
    runNumber: 1,
    status,
    targetingKeyField: "userId",
    targetingKeyType: "user",
    salt: "run-salt",
    allocation: JSON.stringify({ control: 50, treatment: 50 }),
    variantSet: JSON.stringify([
      { id: "variant_control", name: "control", value: false },
      { id: "variant_treatment", name: "treatment", value: true },
    ]),
    controlVariantId: "variant_control",
    targetingRules: "[]",
    activationMetricId: null,
    confidenceLevel: 0.95,
    horizon: "sequential",
    targetN: null,
    sampleSizeLocked: null,
    decisionFamily: "[]",
    guardrailDecisions: "[]",
    metricVarianceConfig: "[]",
    configHash: `sha256:${"c".repeat(64)}`,
    startedAt: "2026-09-08T16:00:00.000Z",
    endedAt: status === "ended" ? "2026-09-08T18:02:00.000Z" : null,
    startReason: null,
    endReason: status === "ended" ? "Promote treatment" : null,
    createdAt: "2026-09-08T16:00:00.000Z",
    createdBy: ACTOR_ID,
  };
}
function experimentRow() {
  return {
    id: EXPERIMENT_ID,
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    flagId: FLAG_ID,
    status: "running",
    liveRunId: RUN_ID,
  };
}
function flagConfigRow(version: number) {
  return {
    id: "flag_config_conclusion",
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    flagId: FLAG_ID,
    enabled: false,
    availableVariantNames: JSON.stringify(["control", "treatment"]),
    defaultVariantId: "variant_control",
    rollout: null,
    version,
    updatedAt: "2026-09-08T17:00:00.000Z",
  };
}
function variantRows() {
  return [
    { id: "variant_control", flagId: FLAG_ID, name: "control", value: "false" },
    { id: "variant_treatment", flagId: FLAG_ID, name: "treatment", value: "true" },
  ];
}
function environmentRow() {
  return {
    id: ENVIRONMENT_ID,
    appId: APP_ID,
    policy: JSON.stringify({
      variantAvailability: "allow",
      targetingRolloutValue: "allow",
      enabledState: "allow",
      startExperimentRun: "allow",
    }),
  };
}
export async function resultToken(stats: StatsOutput): Promise<`sha256:${string}`> {
  return canonicalHash({
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    experimentId: EXPERIMENT_ID,
    runId: RUN_ID,
    runConfigHash: runRow("running").configHash,
    stats,
  });
}
export function readyEnvelope(stats: StatsOutput, token: `sha256:${string}`): AnalysisEnvelope {
  return {
    state: "ready",
    run_id: RUN_ID,
    control_variant: "control",
    data_watermark: WATERMARK,
    result_token: token,
    stats,
  };
}
