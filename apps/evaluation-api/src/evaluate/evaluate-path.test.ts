import { describe, expect, it } from "vitest";
import { hashedAssignmentIdentity } from "../assignment/assignment-store.js";
import {
  RecordingKv,
  RecordingWriterNamespace,
  StaticSaltStore,
} from "../assignment/assignment-store-test-fixtures.js";
import { KvAssignmentStore } from "../assignment/kv-assignment-store.js";
import { ProviderError } from "../provider/provider.js";
import { evaluatePath } from "./evaluate-path.js";
import {
  EXPERIMENT_ID,
  RecordingAssignmentStore,
  RecordingLogger,
  RecordingProvider,
  baseInput,
  experimentConfig,
  flagConfig,
  runConfig,
} from "./evaluate-path-test-fixtures.js";

describe("evaluatePath orchestration", () => {
  it("resolves the Experiment before reading holdovers so idType can be validated", async () => {
    const calls: string[] = [];
    const store = new RecordingAssignmentStore({ calls });
    const provider = new RecordingProvider({ calls });

    await evaluatePath(baseInput(), { assignmentStore: store, provider });

    expect(calls.slice(0, 3)).toEqual(["getFlag", "getExperiment", "getAll"]);
  });
});

describe("evaluatePath no-exposure paths", () => {
  it("disabled returns a structurally distinct no-exposure result", async () => {
    const store = new RecordingAssignmentStore();
    const provider = new RecordingProvider({ flag: flagConfig({ enabled: false }) });

    const result = await evaluatePath(baseInput(), { assignmentStore: store, provider });

    expect(result).toMatchObject({
      kind: "disabled",
      variant: "control",
      reason: { type: "default_disabled" },
      liveRunId: null,
      exposure: null,
    });
    expect(provider.experimentCalls).toEqual([]);
    expect(store.putCalls).toEqual([]);
  });

  it("a flag with no Experiment uses flag-only Targeting Rules and fires no Exposure", async () => {
    const store = new RecordingAssignmentStore();
    const provider = new RecordingProvider({
      flag: flagConfig({
        experimentId: null,
        targetingRules: [
          {
            id: "rule-flag-only",
            flagId: "flag-1",
            priority: 0,
            conditions: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
            variantId: "v-treatment",
          },
        ],
      }),
    });

    const result = await evaluatePath(baseInput(), { assignmentStore: store, provider });

    expect(result).toMatchObject({
      kind: "rule_match_direct",
      variant: "treatment",
      reason: { type: "rule_matched", ruleId: "rule-flag-only" },
      liveRunId: null,
      exposure: null,
    });
    expect(provider.experimentCalls).toEqual([]);
    expect(store.getAllCalls).toEqual([]);
    expect(store.putCalls).toEqual([]);
  });

  it("idType mismatch fails loud before holdover replay or Assignment Store read", async () => {
    const store = new RecordingAssignmentStore({
      holdovers: new Map([[EXPERIMENT_ID, { runId: "run-prior", variant: "treatment" }]]),
    });
    const provider = new RecordingProvider({
      experiment: experimentConfig({ targetingKeyType: "workspace" }),
    });
    const logger = new RecordingLogger();

    const result = await evaluatePath(baseInput(), { assignmentStore: store, provider, logger });

    expect(result).toMatchObject({
      kind: "error",
      variant: "control",
      reason: "ERROR",
      errorCode: "VALIDATION_ERROR",
      liveRunId: null,
      exposure: null,
    });
    expect(provider.experimentCalls).toEqual([EXPERIMENT_ID]);
    expect(store.getAllCalls).toEqual([]);
    expect(store.putCalls).toEqual([]);
    expect(logger.errors).toHaveLength(1);
  });

  it("holdover replay returns the prior Variant, fires no Exposure, and triggers no Assignment Store put", async () => {
    const store = new RecordingAssignmentStore({
      holdovers: new Map([[EXPERIMENT_ID, { runId: "run-prior", variant: "control" }]]),
    });
    const provider = new RecordingProvider({
      experiment: experimentConfig({
        liveRun: runConfig({
          allocation: { control: 0, treatment: 100 },
        }),
      }),
    });

    const result = await evaluatePath(baseInput(), { assignmentStore: store, provider });

    expect(result).toEqual({
      kind: "holdover_replay",
      variant: "control",
      reason: { type: "holdover_replay", priorRunId: "run-prior" },
      isHoldover: true,
      priorRunId: "run-prior",
      liveRunId: null,
      exposure: null,
    });
    expect(provider.experimentCalls).toEqual([EXPERIMENT_ID]);
    expect(store.putCalls).toEqual([]);
  });

  it("another Experiment's holdover is read but never serialized into the result", async () => {
    const store = new RecordingAssignmentStore({
      holdovers: new Map([["exp-other", { runId: "run-secret", variant: "secret-variant" }]]),
    });
    const provider = new RecordingProvider({ experiment: experimentConfig({ liveRun: null }) });

    const result = await evaluatePath(baseInput(), { assignmentStore: store, provider });

    expect(result.kind).toBe("no_match_default");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("exp-other");
    expect(serialized).not.toContain("run-secret");
    expect(serialized).not.toContain("secret-variant");
  });

  it("no live Experiment Run returns a distinct default result with no Exposure", async () => {
    const store = new RecordingAssignmentStore();
    const provider = new RecordingProvider({ experiment: experimentConfig({ liveRun: null }) });

    const result = await evaluatePath(baseInput(), { assignmentStore: store, provider });

    expect(result).toMatchObject({
      kind: "no_match_default",
      variant: "control",
      reason: { type: "no_match_default" },
      liveRunId: null,
      exposure: null,
    });
    expect(store.putCalls).toEqual([]);
  });
});

describe("evaluatePath failure path", () => {
  it("a corrupt Assignment Store read yields ERROR with no Exposure and no Assignment Store put", async () => {
    const input = baseInput();
    const saltStore = new StaticSaltStore();
    const kv = new RecordingKv();
    const namespace = new RecordingWriterNamespace();
    const { entityKey } = await hashedAssignmentIdentity(saltStore, {
      appId: input.appId,
      idType: input.evaluationContext.idType,
      targetingKey: input.evaluationContext.targetingKey,
    });
    kv.putRaw(
      entityKey,
      JSON.stringify({
        schemaVersion: 1,
        data: { [EXPERIMENT_ID]: { runId: "run-prior", variant: 42 } },
      }),
    );
    const store = new KvAssignmentStore(kv, namespace, saltStore);
    const provider = new RecordingProvider({
      experiment: experimentConfig({
        liveRun: runConfig({
          allocation: { control: 0, treatment: 100 },
          targetingRules: [],
        }),
      }),
    });
    const logger = new RecordingLogger();

    const result = await evaluatePath(input, { assignmentStore: store, provider, logger });

    expect(result).toMatchObject({
      kind: "error",
      variant: "control",
      reason: "ERROR",
      errorCode: "INTERNAL_SERVER_ERROR",
      liveRunId: null,
      exposure: null,
    });
    expect(kv.getCalls).toEqual([entityKey]);
    expect(namespace.names).toEqual([]);
    expect(logger.warnings).toEqual([]);
    expect(logger.errors).toHaveLength(1);
  });

  it("a Provider throw yields reason ERROR with no Exposure and no Assignment Store put", async () => {
    const store = new RecordingAssignmentStore();
    const provider = new RecordingProvider({
      getExperimentError: new ProviderError("experiment KV parse failed"),
    });
    const logger = new RecordingLogger();

    const result = await evaluatePath(baseInput(), { assignmentStore: store, provider, logger });

    expect(result).toMatchObject({
      kind: "error",
      variant: "control",
      reason: "ERROR",
      errorCode: "INTERNAL_SERVER_ERROR",
      liveRunId: null,
      exposure: null,
    });
    expect(logger.errors).toHaveLength(1);
    expect(store.putCalls).toEqual([]);
  });
});
