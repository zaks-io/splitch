import { describe, expect, it, vi } from "vitest";
import type { MutationCtx } from "./_generated/server";
import { scheduleSyncRecovery } from "./integration_recovery";

describe("configuration sync recovery", () => {
  it("schedules one recovery mutation while the snapshot is stale", async () => {
    const { ctx, patch, runAfter } = fakeContext({
      announcedVersion: 4,
      snapshotVersion: 3,
    });

    await expect(scheduleSyncRecovery(ctx, integration(), 0)).resolves.toBeUndefined();

    expect(runAfter).toHaveBeenCalledOnce();
    expect(runAfter.mock.calls[0]?.[0]).toBe(0);
    expect(patch).toHaveBeenCalledWith("integration_id", {
      syncRecoveryJobId: "scheduled_job",
      syncRecoveryVersion: 4,
    });
  });

  it("does not duplicate an active recovery for the announced version", async () => {
    const { ctx, patch, runAfter } = fakeContext(
      {
        announcedVersion: 4,
        snapshotVersion: 3,
        syncRecoveryJobId: "existing_job",
        syncRecoveryVersion: 4,
      },
      { state: { kind: "pending" } },
    );

    await expect(
      scheduleSyncRecovery(
        ctx,
        integration({ syncRecoveryJobId: "existing_job", syncRecoveryVersion: 4 }),
        0,
      ),
    ).resolves.toBeUndefined();

    expect(runAfter).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("replaces a pending recovery for an older announced version", async () => {
    const { ctx, patch, runAfter, cancel } = fakeContext(
      {
        announcedVersion: 4,
        snapshotVersion: 3,
        syncRecoveryJobId: "existing_job",
        syncRecoveryVersion: 3,
      },
      { state: { kind: "pending" } },
    );

    await expect(
      scheduleSyncRecovery(
        ctx,
        integration({ syncRecoveryJobId: "existing_job", syncRecoveryVersion: 3 }),
        0,
      ),
    ).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalledWith("existing_job");
    expect(runAfter).toHaveBeenCalledOnce();
    expect(patch).toHaveBeenCalledWith("integration_id", {
      syncRecoveryJobId: "scheduled_job",
      syncRecoveryVersion: 4,
    });
  });
});

function fakeContext(
  fields: {
    announcedVersion: number;
    snapshotVersion?: number;
    syncRecoveryJobId?: string;
    syncRecoveryVersion?: number;
  },
  scheduledJob: unknown = null,
): {
  ctx: MutationCtx;
  patch: ReturnType<typeof vi.fn>;
  runAfter: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} {
  const integration = {
    _id: "integration_id",
    state: "active",
    ...fields,
  };
  const unique = vi.fn().mockResolvedValue(integration);
  const withIndex = vi.fn().mockReturnValue({ unique });
  const query = vi.fn().mockReturnValue({ withIndex });
  const patch = vi.fn().mockResolvedValue(undefined);
  const runAfter = vi.fn().mockResolvedValue("scheduled_job");
  const cancel = vi.fn().mockResolvedValue(undefined);
  return {
    ctx: {
      db: {
        query,
        patch,
        system: { get: vi.fn().mockResolvedValue(scheduledJob) },
      },
      scheduler: { cancel, runAfter },
    } as unknown as MutationCtx,
    patch,
    runAfter,
    cancel,
  };
}

function integration(overrides: Record<string, unknown> = {}) {
  return {
    _id: "integration_id",
    state: "active",
    announcedVersion: 4,
    snapshotVersion: 3,
    ...overrides,
  } as never;
}
