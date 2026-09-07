import type { ConvexServerExposureItem } from "@splitch/contracts";
import type { HandlerArgs } from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { INTEGRATION_EXPOSURE_BATCH_CONCURRENCY } from "./convex-exposure-batch";
import { makeConvexExposuresHandler } from "./convex-exposures";
import {
  completedHoldover,
  provider,
  readOnlyAssignments,
  requestArgs,
  resolver,
  saltStore,
} from "./convex-exposures-test-fixture";
import { RecordingExposureIngestSink } from "./exposure-redemption";
import { MemoryExposureRedemptionClaimStore } from "./exposure-redemption-claim";
import { RecordingPerformanceSpanRecorder } from "./performance-span-test-fixture";

describe("integration Exposure batch handler scheduling", () => {
  it("overlaps independent items within the bound and preserves result order", async () => {
    const items = Array.from({ length: INTEGRATION_EXPOSURE_BATCH_CONCURRENCY + 2 }, (_, index) =>
      exposureItem(index + 1, { targetingKey: `entity-${String(index + 1)}` }),
    );
    let active = 0;
    let maxActive = 0;
    let releaseClaims!: () => void;
    const claimsGate = new Promise<void>((resolve) => {
      releaseClaims = resolve;
    });
    let reachedBound!: () => void;
    const boundReached = new Promise<void>((resolve) => {
      reachedBound = resolve;
    });
    const claims = {
      async claim() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (active === INTEGRATION_EXPOSURE_BATCH_CONCURRENCY) reachedBound();
        await claimsGate;
        active -= 1;
        return { status: "acquired" as const };
      },
      async release() {},
      async markSealed() {},
      async acknowledge() {
        return { status: "accepted" as const };
      },
    };
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: resolver(),
      exposureIngestSink: new RecordingExposureIngestSink(),
      exposureRedemptionClaims: claims,
      holdoverWrite: completedHoldover(),
      saltStore: saltStore(),
      now: () => new Date("2026-08-25T12:00:01.000Z"),
    });

    const pendingResponse = handler(requestWithItems(items));
    await boundReached;
    expect(active).toBe(INTEGRATION_EXPOSURE_BATCH_CONCURRENCY);
    releaseClaims();

    const body = (await (await pendingResponse).json()) as {
      results: Array<{ exposureId: string; status: string }>;
    };
    expect(maxActive).toBe(INTEGRATION_EXPOSURE_BATCH_CONCURRENCY);
    expect(body.results.map(({ exposureId }) => exposureId)).toEqual(
      items.map(({ exposureId }) => exposureId),
    );
    expect(body.results.every(({ status }) => status === "accepted")).toBe(true);
  });

  it("serializes conflicting Exposure IDs so the later item observes the first result", async () => {
    const first = exposureItem(1, { targetingKey: "entity-a" });
    const second = exposureItem(1, { targetingKey: "entity-b" });
    const sink = new RecordingExposureIngestSink();
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: resolver(),
      exposureIngestSink: sink,
      exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
      holdoverWrite: completedHoldover(),
      saltStore: saltStore(),
      now: () => new Date("2026-08-25T12:00:01.000Z"),
    });

    const body = await (await handler(requestWithItems([first, second]))).json();

    expect(body).toEqual({
      results: [
        { exposureId: first.exposureId, status: "accepted" },
        {
          exposureId: second.exposureId,
          status: "rejected",
          code: "EVENT_ID_CONFLICT",
          message: "EVENT_ID_CONFLICT",
          retryable: false,
        },
      ],
    });
    expect(sink.writes).toHaveLength(1);
  });
});

describe("integration Exposure batch Assignment and spans", () => {
  it("serializes one Assignment across Experiment Runs", async () => {
    const first = exposureItem(1);
    const second = exposureItem(2, { runId: "run_2", runConfigHash: "sha256:run-2" });
    let releaseFirstHoldover!: () => void;
    const firstHoldoverGate = new Promise<void>((resolve) => {
      releaseFirstHoldover = resolve;
    });
    let firstHoldoverStarted!: () => void;
    const firstHoldover = new Promise<void>((resolve) => {
      firstHoldoverStarted = resolve;
    });
    const claimed: string[] = [];
    const ensuredRuns: string[] = [];
    const claims = {
      async claim(input: { exposureId: string }) {
        claimed.push(input.exposureId);
        return { status: "acquired" as const };
      },
      async release() {},
      async markSealed() {},
      async acknowledge() {
        return { status: "accepted" as const };
      },
    };
    const handler = makeConvexExposuresHandler({
      provider: provider(),
      assignmentStore: readOnlyAssignments(),
      convexConfigurationResolver: resolverForItemRuns(),
      exposureIngestSink: new RecordingExposureIngestSink(),
      exposureRedemptionClaims: claims,
      holdoverWrite: {
        async ensure(input) {
          ensuredRuns.push(input.runId);
          if (input.runId === first.runId) {
            firstHoldoverStarted();
            await firstHoldoverGate;
          }
          return { status: "completed" as const };
        },
      },
      saltStore: saltStore(),
      now: () => new Date("2026-08-25T12:00:01.000Z"),
    });

    const pendingResponse = handler(requestWithItems([first, second]));
    await firstHoldover;
    expect(claimed).toEqual([first.exposureId]);
    releaseFirstHoldover();

    expect(await (await pendingResponse).json()).toEqual({
      results: [
        { exposureId: first.exposureId, status: "accepted" },
        { exposureId: second.exposureId, status: "accepted" },
      ],
    });
    expect(ensuredRuns).toEqual(["run_1", "run_2"]);
  });

  it.each(["convex", "cloudflare"] as const)(
    "records %s configuration, admission, and per-item spans without item data",
    async (integrationKind) => {
      const spans = new RecordingPerformanceSpanRecorder();
      const handler = makeConvexExposuresHandler({
        provider: provider(),
        assignmentStore: readOnlyAssignments(),
        configurationResolver: resolver(),
        integrationKind,
        exposureIngestSink: new RecordingExposureIngestSink(),
        exposureRedemptionClaims: new MemoryExposureRedemptionClaimStore(),
        holdoverWrite: completedHoldover(),
        saltStore: saltStore(),
        spans,
        now: () => new Date("2026-08-25T12:00:01.000Z"),
      });

      expect((await handler(requestArgs())).status).toBe(202);
      const source = integrationKind === "convex" ? "Convex" : "Cloudflare";
      expect(spans.records).toEqual([
        span(`${source} Exposure configuration`, "rpc.client"),
        span(`${source} Exposure identity admission`, "auth"),
        span(`${source} Exposure claim`, "rpc.client"),
        span(`${source} Exposure ingest`, "http.client"),
        span(`${source} Exposure confirmation`, "rpc.client"),
        span(`${source} Exposure holdover`, "rpc.client"),
      ]);
    },
  );
});

function span(name: string, op: string) {
  return { descriptor: { name, op }, attributes: {} };
}

function exposureItem(
  id: number,
  overrides: {
    readonly targetingKey?: string;
    readonly runId?: string;
    readonly runConfigHash?: string;
  } = {},
): ConvexServerExposureItem {
  return {
    exposureId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    installationId: "00000000-0000-4000-8000-000000000002",
    flagKey: "checkout",
    experimentId: "exp_1",
    runId: overrides.runId ?? "run_1",
    runConfigHash: overrides.runConfigHash ?? "sha256:run-1",
    evaluationContext: {
      targetingKey: overrides.targetingKey ?? "shared-entity",
      idType: "user",
      attributes: {},
    },
    variantName: "treatment",
    exposureAt: "2026-08-25T12:00:00.000Z",
  };
}

function requestWithItems(items: readonly ConvexServerExposureItem[]): HandlerArgs<unknown> {
  const args = requestArgs();
  return { ...args, input: { body: { exposures: items } } };
}

function resolverForItemRuns() {
  return {
    async resolveBatch(principal: unknown, items: readonly ConvexServerExposureItem[]) {
      const [base] = await resolver().resolveBatch(principal, items);
      if (base?.status !== "found") throw new Error("missing base verification config");
      return items.map((item) => ({
        status: "found" as const,
        config: { ...base.config, runId: item.runId, runConfigHash: item.runConfigHash },
      }));
    },
  };
}
