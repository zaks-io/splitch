import { inspect } from "node:util";
import { beforeEach, expect, it, vi } from "vitest";
import { runDeliveryRetention } from "./delivery-retention";
import type { ControlPlaneApiEnv } from "./env";

const mocks = vi.hoisted(() => ({
  convex: vi.fn(),
  cloudflare: vi.fn(),
  log: vi.fn(),
  report: vi.fn(),
}));

vi.mock("@splitch/db", () => ({
  createRepository: () => ({
    convex: { pruneDeliveries: mocks.convex },
    cloudflare: { pruneDeliveries: mocks.cloudflare },
  }),
}));
vi.mock(import("@splitch/observability/worker"), async (importOriginal) => ({
  ...(await importOriginal()),
  workerObservabilityWithWaitUntil: () => ({}),
  workerEmitter: () => ({ log: mocks.log }),
  createWorkerFaultReporter: () => mocks.report,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.convex.mockResolvedValue(13);
  mocks.cloudflare.mockResolvedValue(7);
});

const env = { DB: {} } as ControlPlaneApiEnv;
const event = {
  scheduledTime: Date.parse("2026-10-05T08:00:00.000Z"),
  cron: "0 8 * * *",
} as ScheduledController;
const ctx = { waitUntil: vi.fn() };

it("prunes both adapters once at the 30-day cutoff and logs counts", async () => {
  await runDeliveryRetention(env, event, ctx);
  const expected = { completedBefore: "2026-09-05T08:00:00.000Z", limit: 1_000 };
  expect(mocks.convex).toHaveBeenCalledExactlyOnceWith(expected);
  expect(mocks.cloudflare).toHaveBeenCalledExactlyOnceWith(expected);
  expect(mocks.log).toHaveBeenCalledWith(
    "info",
    "delivery-retention",
    expect.objectContaining({
      convex: 13,
      cloudflare: 7,
      completedBefore: expected.completedBefore,
    }),
  );
  expect(mocks.log).toHaveBeenCalledOnce();
  expect(mocks.report).not.toHaveBeenCalled();
});

it.each([
  { convex: 1_000, cloudflare: 7 },
  { convex: 13, cloudflare: 1_000 },
  { convex: 1_000, cloudflare: 1_000 },
])("reports a reached batch limit with preserved successful counts: %j", async (counts) => {
  mocks.convex.mockResolvedValue(counts.convex);
  mocks.cloudflare.mockResolvedValue(counts.cloudflare);
  await expect(runDeliveryRetention(env, event, ctx)).resolves.toBeUndefined();
  const attributes = {
    service: "splitch-control-plane-api",
    job: "delivery-retention",
    cron: event.cron,
    completedBefore: "2026-09-05T08:00:00.000Z",
    limit: 1_000,
    ...counts,
  };
  expect(mocks.convex).toHaveBeenCalledOnce();
  expect(mocks.cloudflare).toHaveBeenCalledOnce();
  expect(mocks.log).toHaveBeenNthCalledWith(1, "info", "delivery-retention", attributes);
  expect(mocks.log).toHaveBeenNthCalledWith(
    2,
    "warn",
    "delivery-retention-batch-limit-reached",
    attributes,
  );
  expect(mocks.report).toHaveBeenCalledExactlyOnceWith(
    "delivery_retention_batch_limit_reached",
    attributes,
  );
});

it("reports and rejects a failed pruning job without claiming success", async () => {
  const error = Object.assign(new Error("private-retention-canary"), {
    data: "private-retention-canary",
    cause: new Error("private-retention-canary"),
  });
  mocks.cloudflare.mockRejectedValue(error);
  const failure = await runDeliveryRetention(env, event, ctx).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("delivery_retention_failed");
  expect(Object.getOwnPropertyNames(failure)).toEqual(["stack", "message"]);
  expect(
    inspect([failure, mocks.report.mock.calls], { showHidden: true, depth: null }),
  ).not.toContain("private-retention-canary");
  expect(mocks.report).toHaveBeenCalledWith(
    "delivery_retention_failed",
    expect.objectContaining({
      job: "delivery-retention",
      cron: event.cron,
    }),
  );
  expect(mocks.log).not.toHaveBeenCalled();
});
