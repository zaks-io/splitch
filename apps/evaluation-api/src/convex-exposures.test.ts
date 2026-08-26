import type { HandlerArgs } from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { makeConvexExposuresHandler } from "./convex-exposures";
import { RecordingExposureIngestSink } from "./exposure-redemption";
import { MemoryExposureRedemptionClaimStore } from "./exposure-redemption-claim";

describe("Convex server Exposure verification", () => {
  it("recomputes the Variant, hashes identity, ingests, and deduplicates retries", async () => {
    const sink = new RecordingExposureIngestSink();
    const holdoverWrites: unknown[] = [];
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: resolver(),
      exposureIngestSink: sink,
      exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
      holdoverWrite: completedHoldover(holdoverWrites),
      saltStore: saltStore(),
      now: () => new Date("2026-08-25T12:00:01.000Z"),
    });
    const args = requestArgs();

    const accepted = await handler(args);
    const duplicate = await handler(args);

    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({
      results: [{ exposureId: EXPOSURE_ID, status: "accepted" }],
    });
    expect(await duplicate.json()).toEqual({
      results: [{ exposureId: EXPOSURE_ID, status: "deduplicated" }],
    });
    expect(sink.writes).toHaveLength(1);
    expect(sink.writes[0]).toMatchObject({
      eventId: EXPOSURE_ID,
      exposureAt: "2026-08-25T12:00:00.000Z",
      sourceId: `convex:${INSTALLATION_ID}`,
      variantName: "treatment",
    });
    expect(sink.writes[0]?.targetingKeyHash).not.toContain("user@example.com");
    expect(holdoverWrites).toHaveLength(2);
    expect(holdoverWrites[0]).toMatchObject({
      appId: "app_1",
      experimentId: "exp_1",
      idType: "user",
      runId: "run_1",
      variant: "treatment",
    });
    expect(JSON.stringify(holdoverWrites[0])).not.toContain("user@example.com");
  });

  it("rejects a Variant assertion that the shared evaluator cannot reproduce", async () => {
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: resolver(),
      exposureIngestSink: new RecordingExposureIngestSink(),
      exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
      holdoverWrite: completedHoldover(),
      saltStore: saltStore(),
      // Pinned like every sibling: the fixture's exposureAt is a fixed instant,
      // so a real clock walks it out of the 24-hour delivery window and the
      // rejection under test turns into a VALIDATION_ERROR a day later.
      now: () => new Date("2026-08-25T12:00:01.000Z"),
    });
    const args = requestArgs();
    const body = (args.input as { body: { exposures: Array<{ variantName: string }> } }).body;
    body.exposures[0] = { ...body.exposures[0], variantName: "control" };

    expect(await (await handler(args)).json()).toEqual({
      results: [
        {
          exposureId: EXPOSURE_ID,
          status: "rejected",
          code: "STALE_CONFIGURATION",
          message: "STALE_CONFIGURATION",
          retryable: false,
        },
      ],
    });
  });

  it("rejects Exposures outside the bounded 24-hour delivery window", async () => {
    const sink = new RecordingExposureIngestSink();
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: resolver(),
      exposureIngestSink: sink,
      exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
      holdoverWrite: completedHoldover(),
      saltStore: saltStore(),
      now: () => new Date("2026-08-26T12:00:00.001Z"),
    });

    expect(await (await handler(requestArgs())).json()).toEqual({
      results: [
        {
          exposureId: EXPOSURE_ID,
          status: "rejected",
          code: "VALIDATION_ERROR",
          message: "VALIDATION_ERROR",
          retryable: false,
        },
      ],
    });
    expect(sink.writes).toHaveLength(0);
  });

  it("accepts delayed delivery against an immutable ended Run", async () => {
    const sink = new RecordingExposureIngestSink();
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: resolver({ endedAt: "2026-08-25T12:00:00.500Z" }),
      exposureIngestSink: sink,
      exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
      holdoverWrite: completedHoldover(),
      saltStore: saltStore(),
      now: () => new Date("2026-08-25T13:00:00.000Z"),
    });

    expect(await (await handler(requestArgs())).json()).toEqual({
      results: [{ exposureId: EXPOSURE_ID, status: "accepted" }],
    });
    expect(sink.writes).toHaveLength(1);
  });

  it("rejects an encounter outside the immutable Run interval", async () => {
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: resolver({ endedAt: "2026-08-25T11:59:59.999Z" }),
      exposureIngestSink: new RecordingExposureIngestSink(),
      exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
      holdoverWrite: completedHoldover(),
      saltStore: saltStore(),
      now: () => new Date("2026-08-25T13:00:00.000Z"),
    });

    expect(await (await handler(requestArgs())).json()).toEqual({
      results: [
        {
          exposureId: EXPOSURE_ID,
          status: "rejected",
          code: "VALIDATION_ERROR",
          message: "VALIDATION_ERROR",
          retryable: false,
        },
      ],
    });
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

function resolver(overrides: { endedAt?: string | null } = {}) {
  const variants = [
    { id: "control", name: "control", value: false },
    { id: "treatment", name: "treatment", value: true },
  ];
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
          variantSet: variants,
          targetingRules: [],
          startedAt: "2026-08-25T11:00:00.000Z",
          endedAt: overrides.endedAt ?? null,
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

function completedHoldover(writes: unknown[] = []) {
  return {
    async ensure(input: unknown) {
      writes.push(input);
      return { status: "completed" as const };
    },
  };
}

function saltStore() {
  return {
    async currentKeyVersion() {
      return "v1";
    },
    async saltFor() {
      return new TextEncoder().encode("test-salt") as Uint8Array<ArrayBuffer>;
    },
  };
}
