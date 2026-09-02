import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForAppIdentityTrafficLeases } from "../src/config-store-app-identity";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Config Store App identity traffic leases", () => {
  it("holds a reset until the last issued traffic lease expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const deleteLease = vi.fn(async () => true);
    const ctx = {
      storage: {
        get: async () => Date.now() + 1_000,
        delete: deleteLease,
      },
    } as unknown as DurableObjectState;

    const waiting = waitForAppIdentityTrafficLeases(ctx);
    await vi.advanceTimersByTimeAsync(999);
    expect(deleteLease).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(deleteLease).toHaveBeenCalledWith("app-identity-traffic-lease-expires-at");
  });
});
