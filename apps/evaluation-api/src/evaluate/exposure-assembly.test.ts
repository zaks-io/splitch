import { ExposureEventSchema } from "@splitch/contracts";
import { computeTargetingKeyHash } from "@splitch/privacy";
import { describe, expect, it } from "vitest";
import { StaticSaltStore } from "../assignment/assignment-store-test-fixtures";
import { evaluate, peekVariant, verify, evaluateAllFlag } from "./accessor-paths";
import {
  assembleEvaluateExposures,
  assembleExposureFromTicket,
  type ExposureAssemblyDeps,
} from "./exposure-assembly";
import type { FreshAssignmentEvaluateResult } from "./evaluate-path-types";
import {
  APP_ID,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  FLAG_KEY,
  LIVE_RUN_ID,
  RecordingAssignmentStore,
  RecordingProvider,
  baseInput,
  experimentConfig,
  runConfig,
} from "./evaluate-path-test-fixtures";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type EvaluateParamKeys =
  | keyof Parameters<typeof evaluate>[0]
  | keyof Parameters<typeof evaluate>[1]
  | keyof Parameters<typeof evaluate>[2];
type EvaluateHasExactlyThreeArgs = Assert<Equal<Parameters<typeof evaluate>["length"], 3>>;
type EvaluateInputHasNoSuppressExposure = Assert<
  Equal<"suppressExposure" extends EvaluateParamKeys ? true : false, false>
>;

void (undefined as unknown as EvaluateHasExactlyThreeArgs);
void (undefined as unknown as EvaluateInputHasNoSuppressExposure);

const NOW = "2026-07-02T03:00:00.000Z";

function exposureDeps(overrides: Partial<ExposureAssemblyDeps> = {}): ExposureAssemblyDeps {
  return {
    saltStore: new StaticSaltStore(),
    sourceId: "pop-test",
    newEventId: () => "evt-1",
    now: () => new Date(NOW),
    ...overrides,
  };
}

describe("evaluate Exposure assembly", () => {
  it("fresh assignment assembles exactly one Exposure from the auth context and EvaluateResult", async () => {
    const input = baseInput();
    const store = new RecordingAssignmentStore();
    const provider = new RecordingProvider({
      experiment: experimentConfig({
        liveRun: runConfig({
          allocation: { control: 0, treatment: 100 },
          targetingRules: [],
        }),
      }),
    });

    const output = await evaluate(input, { assignmentStore: store, provider }, exposureDeps());

    expect(output.result).toMatchObject({
      kind: "fresh_assignment",
      liveRunId: LIVE_RUN_ID,
      exposure: { liveRunId: LIVE_RUN_ID },
    });
    expect(output.exposures).toHaveLength(1);

    const exposure = output.exposures[0];
    if (exposure === undefined) {
      throw new Error("expected one assembled Exposure");
    }
    expect(exposure).toMatchObject({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      experimentId: EXPERIMENT_ID,
      runId: LIVE_RUN_ID,
      idType: "user",
      variantName: "treatment",
      type: "exposure",
      eventId: "evt-1",
      sourceId: "pop-test",
      counterfactual: false,
      isHoldover: false,
      clientTimestamp: NOW,
      exposureAt: NOW,
      serverReceivedAt: NOW,
    });
    expect(exposure.targetingKeyHash).toBe(
      await computeTargetingKeyHash(new StaticSaltStore(), {
        appId: APP_ID,
        idType: "user",
        targetingKey: input.evaluationContext.targetingKey,
      }),
    );
    expect(exposure.dedupKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ExposureEventSchema.parse(exposure)).toMatchObject({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      runId: LIVE_RUN_ID,
      counterfactual: false,
    });
    expect(store.putCalls).toEqual([]);
  });

  it("stamps ticket redemption exposureAt from the server receipt clock", async () => {
    const exposure = await assembleExposureFromTicket({
      ticket: {
        app_id: APP_ID,
        environment_id: ENVIRONMENT_ID,
        experiment_id: EXPERIMENT_ID,
        run_id: LIVE_RUN_ID,
        flag_key: FLAG_KEY,
        variant: "treatment",
        id_type: "user",
        targeting_key_hash: "hmac:ticket-entity",
        entity_family_hash: "v1:ticket-entity",
        identity_version: "hmac",
        issued_at: "2026-07-02T02:00:00.000Z",
      },
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      exposureId: "550e8400-e29b-41d4-a716-446655440000",
      clientTimestamp: "2026-07-02T02:59:59.000Z",
      sourceId: "pop-test",
      now: () => new Date(NOW),
    });

    expect(exposure.exposureAt).toBe(NOW);
    expect(exposure.serverReceivedAt).toBe(NOW);
    expect(exposure.clientTimestamp).toBe("2026-07-02T02:59:59.000Z");
  });

  it("holdover replay assembles zero Exposures and writes no Assignment Store record", async () => {
    const store = new RecordingAssignmentStore({
      holdovers: new Map([[EXPERIMENT_ID, { runId: "run-prior", variant: "control" }]]),
    });
    const provider = new RecordingProvider({
      experiment: experimentConfig({
        liveRun: runConfig({
          allocation: { control: 0, treatment: 100 },
          targetingRules: [],
        }),
      }),
    });

    const output = await evaluate(
      baseInput(),
      { assignmentStore: store, provider },
      exposureDeps(),
    );

    expect(output.result).toMatchObject({
      kind: "holdover_replay",
      isHoldover: true,
      exposure: null,
    });
    expect(output.exposures).toEqual([]);
    expect(store.putCalls).toEqual([]);
  });

  it("uses EvaluateResult.liveRunId for Exposure.runId instead of the decision payload", async () => {
    const result: FreshAssignmentEvaluateResult = {
      kind: "fresh_assignment",
      variant: "treatment",
      reason: { type: "fresh_assignment" },
      experimentId: EXPERIMENT_ID,
      liveRunId: "run-from-result",
      exposure: {
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        experimentId: EXPERIMENT_ID,
        flagKey: FLAG_KEY,
        idType: "user",
        liveRunId: "stale-decision-run",
        targetingKey: "user-1",
        variant: "treatment",
      },
    };

    const exposures = await assembleEvaluateExposures(baseInput(), result, exposureDeps());

    expect(exposures).toHaveLength(1);
    expect(exposures[0]?.runId).toBe("run-from-result");
  });

  it("keeps peekVariant, verify, and evaluateAllFlag structurally no-exposure with no Assignment Store put", async () => {
    for (const accessor of [peekVariant, verify, evaluateAllFlag]) {
      const store = new RecordingAssignmentStore();
      const provider = new RecordingProvider({
        experiment: experimentConfig({
          liveRun: runConfig({
            allocation: { control: 0, treatment: 100 },
            targetingRules: [],
          }),
        }),
      });

      const output = await accessor(baseInput(), { assignmentStore: store, provider });

      expect(output.result.kind).toBe("fresh_assignment");
      expect(output.exposures).toEqual([]);
      expect(store.putCalls).toEqual([]);
    }
  });
});
