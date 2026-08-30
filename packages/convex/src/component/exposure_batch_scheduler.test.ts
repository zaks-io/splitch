import { afterEach, describe, expect, it, vi } from "vitest";
import type { MutationCtx } from "./_generated/server";
import { ensureExposureDrainScheduled } from "./exposure_batch";

const NOW = 1_800_000_000_000;

afterEach(() => {
  vi.useRealTimers();
});

describe("Exposure batch successor", () => {
  it("keeps one existing successor when it is already due first", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { ctx, runAfter, cancel } = fakeContext();

    await ensureExposureDrainScheduled(ctx, NOW);
    await ensureExposureDrainScheduled(ctx, NOW + 1_000);

    expect(runAfter).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("replaces a later successor when new work is due sooner", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { ctx, runAfter, cancel } = fakeContext();

    await ensureExposureDrainScheduled(ctx, NOW + 5_000);
    await ensureExposureDrainScheduled(ctx, NOW);

    expect(runAfter.mock.calls.map(([delay]) => delay)).toEqual([5_000, 0]);
    expect(cancel).toHaveBeenCalledWith("job_1");
  });
});

function fakeContext() {
  const integration: Record<string, unknown> = { _id: "integration_1", state: "active" };
  const jobs = new Map<string, { state: { kind: string } }>();
  const runAfter = vi.fn(async () => {
    const id = `job_${jobs.size + 1}`;
    jobs.set(id, { state: { kind: "pending" } });
    return id;
  });
  const cancel = vi.fn(async (id: string) => {
    jobs.set(id, { state: { kind: "canceled" } });
  });
  const patch = vi.fn(async (_id: string, values: Record<string, unknown>) => {
    Object.assign(integration, values);
  });
  const ctx = {
    db: {
      query: vi.fn(() => ({
        withIndex: vi.fn(() => ({ unique: vi.fn().mockResolvedValue(integration) })),
      })),
      patch,
      system: { get: vi.fn(async (_table: string, id: string) => jobs.get(id) ?? null) },
    },
    scheduler: { runAfter, cancel },
  } as unknown as MutationCtx;
  return { ctx, runAfter, cancel };
}
