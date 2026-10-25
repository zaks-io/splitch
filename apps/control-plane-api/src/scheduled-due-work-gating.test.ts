import type { ScheduledDueWork } from "@splitch/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ControlPlaneApiEnv } from "./env";
import { runControlPlaneScheduled } from "./scheduled";

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  convexLag: vi.fn(),
  cloudflareLag: vi.fn(),
  jobs: {
    privacyReconciliation: vi.fn(),
    privacyArtifactPurge: vi.fn(),
    personalAccessTokenRetention: vi.fn(),
    temporaryEnvironmentTeardown: vi.fn(),
    auditEventForwarding: vi.fn(),
    convexWebhookDispatch: vi.fn(),
    cloudflarePushDispatch: vi.fn(),
    sentryWebhookDispatch: vi.fn(),
    demo: vi.fn(),
    adoption: vi.fn(),
    archive: vi.fn(),
    flagRetention: vi.fn(),
    deliveryRetention: vi.fn(),
    auditRetention: vi.fn(),
  },
}));
vi.mock("@splitch/db", () => ({
  createRepository: () => ({
    scheduledDueWork: mocks.probe,
    convex: { deliveryLag: mocks.convexLag },
    cloudflare: { deliveryLag: mocks.cloudflareLag },
    identity: { reapExpiredProvisionalOrganizations: mocks.jobs.demo },
    claim: { purgeExpiredClaimArtifacts: async () => 0 },
    sentry: { minUndeliveredSeq: async () => null },
    flagChangeEvents: { pruneBefore: mocks.jobs.flagRetention },
    auditEvents: { pruneBefore: mocks.jobs.auditRetention },
  }),
}));
vi.mock("./entity-privacy-jobs", () => ({
  RECONCILE_DELAY_MS: 60_000,
  reconcilePrivacyJobs: mocks.jobs.privacyReconciliation,
  purgeExpiredPrivacyArtifacts: mocks.jobs.privacyArtifactPurge,
}));
vi.mock("./personal-access-token-rotation", () => ({
  PERSONAL_ACCESS_TOKEN_RECOVERY_DELAY_MS: 300_000,
  runPersonalAccessTokenRetention: mocks.jobs.personalAccessTokenRetention,
}));
vi.mock("./temporary-environment-teardown-scheduled", () => ({
  runTemporaryEnvironmentTeardown: mocks.jobs.temporaryEnvironmentTeardown,
}));
vi.mock("./audit-events", () => ({ forwardAuditEvents: mocks.jobs.auditEventForwarding }));
vi.mock("./convex-webhook-dispatch", () => ({
  dispatchConvexWebhooks: mocks.jobs.convexWebhookDispatch,
}));
vi.mock("./cloudflare-push-dispatch", () => ({
  dispatchCloudflarePushes: mocks.jobs.cloudflarePushDispatch,
}));
vi.mock("./sentry-webhook-dispatch", () => ({
  dispatchSentryWebhooks: mocks.jobs.sentryWebhookDispatch,
}));
vi.mock("./approval-archive", () => ({ runApprovalRequestArchival: mocks.jobs.archive }));
vi.mock("./approval-archive-tinybird", () => ({ approvalArchiveStoreFromEnv: () => ({}) }));
vi.mock("./delivery-retention", () => ({ runDeliveryRetention: mocks.jobs.deliveryRetention }));
vi.mock("./privacy-export-cleanup", () => ({ deleteOrphanedPrivacyExports: async () => 0 }));

const keys: Array<keyof ScheduledDueWork> = [
  "privacyReconciliation",
  "privacyArtifactPurge",
  "personalAccessTokenRetention",
  "temporaryEnvironmentTeardown",
  "auditEventForwarding",
  "convexWebhookDispatch",
  "cloudflarePushDispatch",
  "sentryWebhookDispatch",
];
const daily = [
  "demo",
  "adoption",
  "archive",
  "flagRetention",
  "deliveryRetention",
  "auditRetention",
] as const;
const idle = Object.fromEntries(keys.map((key) => [key, false]));
beforeEach(() => {
  mocks.convexLag.mockReset().mockResolvedValue([]);
  mocks.cloudflareLag.mockReset().mockResolvedValue([]);
  mocks.probe.mockReset().mockResolvedValue(idle);
  for (const job of Object.values(mocks.jobs)) job.mockReset().mockResolvedValue(0);
  mocks.jobs.demo.mockResolvedValue({ candidates: 0, reaped: 0 });
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
async function tick(cron = "* * * * *") {
  const pending: Promise<unknown>[] = [];
  runControlPlaneScheduled(
    { cron, scheduledTime: Date.parse("2026-10-22T08:00:00.000Z") } as ScheduledController,
    {
      DB: {},
      EVENT_INGEST_API: { adoptMetricEventClaimRetention: mocks.jobs.adoption },
    } as unknown as ControlPlaneApiEnv,
    { waitUntil: (promise) => pending.push(promise) } as unknown as ExecutionContext,
  );
  await Promise.all(pending);
}
it.each(keys)("runs only %s when it is due", async (key) => {
  mocks.probe.mockResolvedValue({ ...idle, [key]: true });
  await tick();
  for (const [name, job] of Object.entries(mocks.jobs))
    expect(job).toHaveBeenCalledTimes(name === key ? 1 : 0);
});
it("runs no jobs on an idle minute tick", async () => {
  await tick();
  for (const job of Object.values(mocks.jobs)) expect(job).not.toHaveBeenCalled();
});
it("reports a failed probe and runs every minute job", async () => {
  mocks.probe.mockRejectedValue(new Error("probe_private_canary"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await tick();
  for (const key of keys) expect(mocks.jobs[key]).toHaveBeenCalledTimes(1);
  for (const key of daily) expect(mocks.jobs[key]).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "scheduled_due_work_probe_failed",
      service: "splitch-control-plane-api",
      cron: "* * * * *",
      fault: expect.any(String),
    }),
  );
  expect(JSON.stringify(error.mock.calls)).not.toContain("probe_private_canary");
});
it.each([false, true])(
  "keeps daily retention ungated and gates the three every-tick jobs when due=%s",
  async (due) => {
    mocks.probe.mockResolvedValue(Object.fromEntries(keys.map((key) => [key, due])));
    await tick("0 8 * * *");
    for (const key of keys)
      expect(mocks.jobs[key]).toHaveBeenCalledTimes(due && keys.indexOf(key) < 3 ? 1 : 0);
    for (const key of daily) expect(mocks.jobs[key]).toHaveBeenCalledTimes(1);
  },
);
it("keeps the same daily job set when the probe fails", async () => {
  mocks.probe.mockRejectedValue(new Error("probe failed"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  await tick("0 8 * * *");
  for (const key of keys)
    expect(mocks.jobs[key]).toHaveBeenCalledTimes(keys.indexOf(key) < 3 ? 1 : 0);
  for (const key of daily) expect(mocks.jobs[key]).toHaveBeenCalledTimes(1);
});

it("logs every healthy Environment and faults once per lagging Environment on an idle minute", async () => {
  mocks.convexLag.mockResolvedValue([
    {
      appId: "app_a",
      environmentId: "env_lag",
      oldestOutstandingAt: "2026-10-22T07:54:00.000Z",
      healthyInstallationsWaiting: 3,
    },
    {
      appId: "app_a",
      environmentId: "env_recent",
      oldestOutstandingAt: "2026-10-22T07:59:00.000Z",
      healthyInstallationsWaiting: 1,
    },
    {
      appId: "app_a",
      environmentId: "env_boundary",
      oldestOutstandingAt: "2026-10-22T07:55:00.000Z",
      healthyInstallationsWaiting: 1,
    },
  ]);
  mocks.cloudflareLag.mockResolvedValue([
    {
      appId: "app_b",
      environmentId: "env_lag",
      oldestOutstandingAt: "2026-10-22T07:53:00.000Z",
      healthyInstallationsWaiting: 2,
    },
  ]);
  const faults = vi.spyOn(console, "error").mockImplementation(() => {});
  await tick();
  expect(mocks.convexLag).toHaveBeenCalledExactlyOnceWith("2026-10-22T08:00:00.000Z");
  expect(mocks.cloudflareLag).toHaveBeenCalledExactlyOnceWith("2026-10-22T08:00:00.000Z");
  expect(console.info).toHaveBeenCalledTimes(4);
  expect(console.info).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "integration-delivery-lag",
      provider: "convex",
      appId: "app_a",
      environmentId: "env_recent",
      oldestAgeMs: 60_000,
      healthyInstallationsWaiting: 1,
    }),
  );
  expect(faults.mock.calls.map(([row]) => row)).toEqual([
    expect.objectContaining({
      message: "integration_delivery_lagging",
      provider: "convex",
      appId: "app_a",
      environmentId: "env_lag",
      oldestAgeMs: 360_000,
      healthyInstallationsWaiting: 3,
    }),
    expect.objectContaining({
      message: "integration_delivery_lagging",
      provider: "cloudflare",
      appId: "app_b",
      environmentId: "env_lag",
      oldestAgeMs: 420_000,
      healthyInstallationsWaiting: 2,
    }),
  ]);
});
it.each(["convex", "cloudflare"] as const)(
  "reports a failed %s lag read without blocking dispatch or the other read",
  async (provider) => {
    mocks[provider === "convex" ? "convexLag" : "cloudflareLag"].mockRejectedValue(
      new Error("lag_private_canary"),
    );
    mocks.probe.mockResolvedValue({
      ...idle,
      convexWebhookDispatch: true,
      cloudflarePushDispatch: true,
    });
    const faults = vi.spyOn(console, "error").mockImplementation(() => {});
    await tick();
    expect(mocks.jobs.convexWebhookDispatch).toHaveBeenCalledTimes(1);
    expect(mocks.jobs.cloudflarePushDispatch).toHaveBeenCalledTimes(1);
    expect(mocks.convexLag).toHaveBeenCalledTimes(1);
    expect(mocks.cloudflareLag).toHaveBeenCalledTimes(1);
    expect(faults).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "integration_delivery_lag_read_failed", provider }),
    );
    expect(JSON.stringify(faults.mock.calls)).not.toContain("lag_private_canary");
  },
);
it("does not read delivery lag on the daily cron", async () => {
  await tick("0 8 * * *");
  expect(mocks.convexLag).not.toHaveBeenCalled();
  expect(mocks.cloudflareLag).not.toHaveBeenCalled();
});
