import { afterEach, describe, expect, it, vi } from "vitest";
import type { MutationCtx } from "./_generated/server";
import { ensureRetentionScheduled } from "./retention";

const NOW = 1_800_000_000_000;
const RETENTION_MS = 30 * 86_400_000;

afterEach(() => {
  vi.useRealTimers();
});

describe("retention scheduling", () => {
  it("schedules cleanup for the earliest retained record", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const createdAt = NOW - 1_000;
    const { ctx, patch, runAfter } = fakeContext({
      evaluationClaim: { createdAt },
    });

    await ensureRetentionScheduled(ctx);

    expect(runAfter).toHaveBeenCalledOnce();
    expect(runAfter.mock.calls[0]?.[0]).toBe(RETENTION_MS - 1_000);
    expect(patch).toHaveBeenCalledWith("integration_id", {
      retentionJobId: "scheduled_job",
      retentionDueAt: createdAt + RETENTION_MS,
    });
  });

  it("does not duplicate an active cleanup job", async () => {
    const { ctx, patch, runAfter } = fakeContext({
      integration: { retentionJobId: "existing_job", retentionDueAt: NOW },
      scheduledJob: { state: { kind: "pending" } },
    });

    await ensureRetentionScheduled(ctx);

    expect(runAfter).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("retains a completed Metric Event claim for 30 days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const completedAt = NOW - 2_000;
    const { ctx, patch, runAfter } = fakeContext({ metricEventClaim: { completedAt } });

    await ensureRetentionScheduled(ctx);

    expect(runAfter.mock.calls[0]?.[0]).toBe(RETENTION_MS - 2_000);
    expect(patch).toHaveBeenCalledWith("integration_id", {
      retentionJobId: "scheduled_job",
      retentionDueAt: completedAt + RETENTION_MS,
    });
  });

  it("does nothing when there is no retained data", async () => {
    const { ctx, patch, runAfter } = fakeContext({});

    await ensureRetentionScheduled(ctx);

    expect(runAfter).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });
});

function fakeContext(options: {
  integration?: Record<string, unknown>;
  evaluationClaim?: { createdAt?: number };
  webhookClaim?: { claimedAt: number };
  terminalExposure?: { terminalAt?: number };
  metricEventClaim?: { completedAt?: number };
  scheduledJob?: unknown;
}): {
  ctx: MutationCtx;
  patch: ReturnType<typeof vi.fn>;
  runAfter: ReturnType<typeof vi.fn>;
} {
  const integration = {
    _id: "integration_id",
    ...options.integration,
  };
  const rows: Record<string, unknown> = {
    evaluationClaims: options.evaluationClaim ?? null,
    webhookClaims: options.webhookClaim ?? null,
    exposureOutbox: options.terminalExposure ?? null,
    metricEventClaims: options.metricEventClaim ?? null,
  };
  const query = vi.fn((table: string) => {
    if (table === "integrations") {
      return { withIndex: vi.fn(() => ({ unique: vi.fn().mockResolvedValue(integration) })) };
    }
    return {
      withIndex: vi.fn(() => ({
        order: vi.fn(() => ({ first: vi.fn().mockResolvedValue(rows[table]) })),
      })),
    };
  });
  const patch = vi.fn().mockResolvedValue(undefined);
  const runAfter = vi.fn().mockResolvedValue("scheduled_job");
  return {
    ctx: {
      db: {
        query,
        patch,
        system: { get: vi.fn().mockResolvedValue(options.scheduledJob ?? null) },
      },
      scheduler: { cancel: vi.fn(), runAfter },
    } as unknown as MutationCtx,
    patch,
    runAfter,
  };
}
