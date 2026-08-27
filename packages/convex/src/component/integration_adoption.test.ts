import { describe, expect, it, vi } from "vitest";
import type { MutationCtx } from "./_generated/server";
import {
  adoptExistingWorkHandler,
  RECOVERY_GENERATION,
  scheduleRecoveryAdoption,
} from "./integration_recovery";

describe("scheduled recovery adoption", () => {
  it("attaches recovery watches to pre-upgrade delivery rows", async () => {
    const pending = [{ _id: "pending_id", exposureId: "exp_pending" }];
    const delivering = [{ _id: "delivering_id", exposureId: "exp_delivering" }];
    const { ctx, patch, runAfter } = fakeContext({ pending, delivering });

    await adoptExistingWorkHandler(ctx, { generation: RECOVERY_GENERATION });

    expect(runAfter).toHaveBeenCalledTimes(2);
    expect(runAfter.mock.calls.map((call) => call[2])).toEqual([
      { exposureId: "exp_pending" },
      { exposureId: "exp_delivering" },
    ]);
    expect(patch).toHaveBeenCalledWith("pending_id", {
      recoveryWatchGeneration: RECOVERY_GENERATION,
    });
    expect(patch).toHaveBeenCalledWith("delivering_id", {
      recoveryWatchGeneration: RECOVERY_GENERATION,
    });
    expect(patch).toHaveBeenCalledWith("integration_id", {
      recoveryAdoptionJobId: undefined,
      recoveryGeneration: RECOVERY_GENERATION,
    });
  });

  it("continues in bounded batches", async () => {
    const pending = Array.from({ length: 25 }, (_, index) => ({
      _id: `pending_${index}`,
      exposureId: `exp_${index}`,
    }));
    const { ctx, patch, runAfter } = fakeContext({ pending });

    await adoptExistingWorkHandler(ctx, { generation: RECOVERY_GENERATION });

    expect(runAfter).toHaveBeenCalledTimes(26);
    expect(runAfter.mock.calls[25]?.[0]).toBe(0);
    expect(runAfter.mock.calls[25]?.[2]).toEqual({ generation: RECOVERY_GENERATION });
    expect(patch).toHaveBeenCalledWith("integration_id", {
      recoveryAdoptionJobId: "scheduled_job",
    });
    expect(patch).not.toHaveBeenCalledWith(
      "integration_id",
      expect.objectContaining({ recoveryGeneration: RECOVERY_GENERATION }),
    );
  });

  it("does not duplicate a completed or active adoption", async () => {
    const completed = fakeContext({ integration: { recoveryGeneration: RECOVERY_GENERATION } });
    await adoptExistingWorkHandler(completed.ctx, { generation: RECOVERY_GENERATION });
    expect(completed.runAfter).not.toHaveBeenCalled();

    const active = fakeContext({ scheduledJob: { state: { kind: "pending" } } });
    await scheduleRecoveryAdoption(
      active.ctx,
      integration({ recoveryAdoptionJobId: "existing_job" }),
    );
    expect(active.runAfter).not.toHaveBeenCalled();
    expect(active.patch).not.toHaveBeenCalled();
  });
});

function fakeContext(options: {
  integration?: Record<string, unknown>;
  pending?: Array<{ _id: string; exposureId: string }>;
  delivering?: Array<{ _id: string; exposureId: string }>;
  scheduledJob?: unknown;
}): {
  ctx: MutationCtx;
  patch: ReturnType<typeof vi.fn>;
  runAfter: ReturnType<typeof vi.fn>;
} {
  const current = { _id: "integration_id", state: "active", ...options.integration };
  const query = vi.fn((table: string) => {
    if (table === "integrations") {
      return { withIndex: vi.fn(() => ({ unique: vi.fn().mockResolvedValue(current) })) };
    }
    if (table === "exposureOutbox") {
      return {
        withIndex: vi.fn((index: string, applyIndex: (query: unknown) => unknown) => {
          if (index !== "by_recovery_watch_state") {
            return { order: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null) })) };
          }
          let state: "pending" | "delivering" | undefined;
          const indexQuery = {
            eq: vi.fn((field: string, value: unknown) => {
              if (field === "state") state = value as "pending" | "delivering";
              return indexQuery;
            }),
          };
          applyIndex(indexQuery);
          return {
            take: vi
              .fn()
              .mockResolvedValue(
                state === "pending" ? (options.pending ?? []) : (options.delivering ?? []),
              ),
          };
        }),
      };
    }
    return {
      withIndex: vi.fn(() => ({
        order: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null) })),
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

function integration(overrides: Record<string, unknown> = {}) {
  return {
    _id: "integration_id",
    state: "active",
    announcedVersion: 4,
    snapshotVersion: 4,
    ...overrides,
  } as never;
}
