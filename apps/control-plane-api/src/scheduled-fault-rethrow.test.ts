import { inspect } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ControlPlaneApiEnv } from "./env";
import { runControlPlaneScheduled } from "./scheduled";

const jobs = vi.hoisted(() => ({
  deploymentReprobes: vi.fn(),
  cloudflare: vi.fn(),
  sentry: vi.fn(),
  adoption: vi.fn(),
  archive: vi.fn(),
  auditForward: vi.fn(),
  auditRetention: vi.fn(),
}));

vi.mock("@splitch/db", () => ({
  createRepository: () => ({
    convex: { deliveryLag: async () => [], dormantDeployments: jobs.deploymentReprobes },
    cloudflare: { deliveryLag: async () => [] },
    identity: {
      reapExpiredProvisionalOrganizations: async () => ({ candidates: 0, reaped: 0 }),
      listExpiredTemporaryEnvironments: async () => [],
    },
    claim: { purgeExpiredClaimArtifacts: async () => 0 },
    sentry: { minUndeliveredSeq: async () => null },
    flagChangeEvents: { pruneBefore: async () => 0 },
    auditEvents: { pruneBefore: jobs.auditRetention },
  }),
}));
vi.mock("./audit-events", () => ({ forwardAuditEvents: jobs.auditForward }));
vi.mock("./cloudflare-push-dispatch", () => ({ dispatchCloudflarePushes: jobs.cloudflare }));
vi.mock("./sentry-webhook-dispatch", () => ({ dispatchSentryWebhooks: jobs.sentry }));
vi.mock("./approval-archive", () => ({
  APPROVAL_ARCHIVE_VERSION: 1,
  runApprovalRequestArchival: jobs.archive,
}));
vi.mock("./convex-webhook-dispatch", () => ({ dispatchConvexWebhooks: async () => 0 }));
vi.mock("./delivery-retention", () => ({ runDeliveryRetention: async () => {} }));
vi.mock("./entity-privacy-jobs", () => ({
  reconcilePrivacyJobs: async () => 0,
  purgeExpiredPrivacyArtifacts: async () => 0,
}));
vi.mock("./personal-access-token-rotation", () => ({
  runPersonalAccessTokenRetention: async () => {},
}));

beforeEach(() => {
  for (const job of Object.values(jobs)) job.mockReset().mockResolvedValue(0);
  jobs.deploymentReprobes.mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

it.each([
  ["cloudflare", "* * * * *", "cloudflare_push_dispatch_failed"],
  ["sentry", "* * * * *", "sentry_webhook_dispatch_failed"],
  ["deploymentReprobes", "0 8 * * *", "convex_deployment_reprobe_failed"],
  ["adoption", "0 8 * * *", "metric_event_claim_retention_adoption_failed"],
  ["archive", "0 8 * * *", "approval_request_archive_failed"],
  ["auditForward", "* * * * *", "audit_event_forward_failed"],
  ["auditRetention", "0 8 * * *", "audit_event_retention_failed"],
] as const)(
  "reports %s failure and rejects waitUntil with only its fault code",
  async (job, cron, code) => {
    const canary = "scheduledprivatecanary";
    const original = Object.assign(new Error(canary, { cause: new Error(canary) }), {
      data: canary,
    });
    jobs[job].mockRejectedValue(original);
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const pending: Promise<unknown>[] = [];
    runControlPlaneScheduled(
      { cron, scheduledTime: Date.parse("2026-10-05T08:00:00Z") } as ScheduledController,
      {
        DB: {},
        EVENT_INGEST_API: { adoptMetricEventClaimRetention: jobs.adoption },
        PRIVACY_EXPORTS: { list: async () => ({ objects: [], truncated: false }) },
      } as unknown as ControlPlaneApiEnv,
      { waitUntil: (promise) => pending.push(promise) } as unknown as ExecutionContext,
    );
    const results = await Promise.allSettled(pending);
    const failures = results.filter((result) => result.status === "rejected");
    expect(failures).toHaveLength(1);
    const failure = failures[0].reason;
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe(code);
    expect(Object.getOwnPropertyNames(failure)).toEqual(["stack", "message"]);
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({ message: code }));
    expect(inspect([failures, logs.mock.calls], { showHidden: true, depth: null })).not.toContain(
      canary,
    );
  },
);
