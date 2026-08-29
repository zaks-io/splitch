import type { HandlerArgs } from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { makeConvexExposuresHandler } from "./convex-exposures";
import { RecordingExposureIngestSink } from "./exposure-redemption";
import { MemoryExposureRedemptionClaimStore } from "./exposure-redemption-claim";

describe("Convex server Exposure identity admission", () => {
  it("rejects integration work paused across an App identity replacement", async () => {
    const sink = new RecordingExposureIngestSink();
    const identity = pausingSaltStore();
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: resolver(),
      exposureIngestSink: sink,
      exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
      holdoverWrite: { ensure: async () => ({ status: "completed" as const }) },
      saltStore: identity.store,
      now: () => new Date("2026-08-25T12:00:01.000Z"),
    });

    const response = handler(requestArgs());
    await identity.paused;
    identity.replace();

    expect(await (await response).json()).toEqual({
      results: [
        {
          exposureId: EXPOSURE_ID,
          status: "rejected",
          code: "SERVICE_UNAVAILABLE",
          message: "SERVICE_UNAVAILABLE",
          retryable: true,
        },
      ],
    });
    expect(sink.writes).toEqual([]);
  });
});

const EXPOSURE_ID = "00000000-0000-4000-8000-000000000001";
const INSTALLATION_ID = "00000000-0000-4000-8000-000000000002";

function requestArgs(): HandlerArgs<unknown> {
  return {
    input: {
      body: {
        exposures: [
          {
            exposureId: EXPOSURE_ID,
            installationId: INSTALLATION_ID,
            flagKey: "checkout",
            experimentId: "exp_1",
            runId: "run_1",
            runConfigHash: "sha256:run-1",
            evaluationContext: {
              targetingKey: "user@example.com",
              idType: "user",
              attributes: {},
            },
            variantName: "treatment",
            exposureAt: "2026-08-25T12:00:00.000Z",
          },
        ],
      },
    },
    principal: {
      kind: "api-key",
      id: "api_key:test",
      scopes: ["data-plane:evaluate"],
      orgId: "org_1",
      appId: "app_1",
      environmentId: "env_1",
      authDoor: null,
    },
    requestId: "request_1",
    request: new Request("https://edge.splitch.dev/api/integrations/convex/exposures"),
  };
}

function provider() {
  const variants = [
    { id: "control", name: "control", value: false },
    { id: "treatment", name: "treatment", value: true },
  ];
  return {
    async getFlag() {
      return {
        flagKey: "checkout",
        appId: "app_1",
        environmentId: "env_1",
        experimentId: "exp_1",
        enabled: true,
        defaultVariant: "control",
        variants,
        availableVariantNames: ["control", "treatment"],
        targetingRules: [],
        rollout: null,
      };
    },
    async getFlags() {
      return [await this.getFlag()];
    },
    async getExperiment() {
      return {
        experimentId: "exp_1",
        appId: "app_1",
        environmentId: "env_1",
        targetingKeyType: "user",
        status: "running" as const,
        liveRunId: "run_1",
        liveRun: {
          runId: "run_1",
          salt: "salt",
          allocation: { control: 0, treatment: 100 },
          variantSet: variants,
          targetingRules: [],
          targetingKey: "userId",
          configHash: "sha256:run-1",
        },
      };
    },
  };
}

function resolver() {
  return {
    async resolve() {
      return {
        status: "found" as const,
        config: {
          appId: "app_1",
          environmentId: "env_1",
          flagKey: "checkout",
          experimentId: "exp_1",
          runId: "run_1",
          runConfigHash: "sha256:run-1",
          targetingKey: "userId",
          targetingKeyType: "user",
          controlVariantId: "control",
          salt: "salt",
          allocation: { control: 0, treatment: 100 },
          variantSet: [
            { id: "control", name: "control", value: false },
            { id: "treatment", name: "treatment", value: true },
          ],
          targetingRules: [],
          startedAt: "2026-08-25T11:00:00.000Z",
          endedAt: null,
        },
      };
    },
  };
}

function readOnlyAssignments() {
  const refuse = async () => {
    throw new Error("read-only");
  };
  return {
    async getAll() {
      return new Map();
    },
    put: refuse,
    putHashed: refuse,
  };
}

function pausingSaltStore() {
  let calls = 0;
  let version = "app-v1";
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return {
    paused,
    replace() {
      version = "app-v2";
      resume();
    },
    store: {
      async currentKeyVersion() {
        calls += 1;
        if (calls === 2) {
          entered();
          await gate;
        }
        return version;
      },
      async saltFor() {
        return new TextEncoder().encode("test-salt") as Uint8Array<ArrayBuffer>;
      },
      async retainedKeyVersions() {
        return [version];
      },
    },
  };
}
