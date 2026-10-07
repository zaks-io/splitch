import { describe, expect, it, vi } from "vitest";
import {
  experimentConfig,
  flagConfig,
  RecordingProvider,
} from "../evaluate/evaluate-path-test-fixtures";
import { CapturingProvider } from "./capturing-provider";
import { ProviderError } from "./provider";

describe("CapturingProvider", () => {
  it("captures Flag resolution and transparently forwards every Provider read", async () => {
    const flag = flagConfig();
    const experiment = experimentConfig();
    const inner = new RecordingProvider({ flag, experiment });
    const provider = new CapturingProvider(inner);

    expect(provider.flag).toBeNull();
    await expect(provider.getExperiment("app-A", "env-1", "exp-7")).resolves.toBe(experiment);
    await expect(provider.getFlags("app-A", "env-1")).resolves.toEqual([flag]);
    await expect(provider.getFlag("app-A", "env-1", "checkout-banner")).resolves.toBe(flag);
    expect(provider.flag).toBe(flag);
  });

  it("shares a prefetched read only within its request and captures it on consumption", async () => {
    const inner = new RecordingProvider();
    const getFlag = vi.spyOn(inner, "getFlag");
    const provider = new CapturingProvider(inner);
    const read = provider.prefetchFlag("app-A", "env-1", "checkout-banner");
    expect(provider.prefetchFlag("app-A", "env-1", "checkout-banner")).toBe(read);
    const flag = await read;
    expect(provider.flag).toBeNull();
    await expect(provider.getFlag("app-A", "env-1", "checkout-banner")).resolves.toBe(flag);
    expect(provider.flag).toBe(flag);
    expect(getFlag).toHaveBeenCalledTimes(1);

    await new CapturingProvider(inner).getFlag("app-A", "env-1", "checkout-banner");
    await provider.getFlag("app-B", "env-1", "checkout-banner");
    await provider.getFlag("app-A", "env-2", "checkout-banner");
    expect(getFlag).toHaveBeenCalledTimes(4);
  });

  it("preserves a synchronous prefetch failure for the evaluator", async () => {
    const failure = new ProviderError("unavailable", { errorCode: "SERVICE_UNAVAILABLE" });
    const inner = new RecordingProvider();
    vi.spyOn(inner, "getFlag").mockImplementation(() => {
      throw failure;
    });
    const provider = new CapturingProvider(inner);
    provider.prefetchFlag("app-A", "env-1", "checkout-banner");
    await expect(provider.getFlag("app-A", "env-1", "checkout-banner")).rejects.toBe(failure);
    expect(provider.flag).toBeNull();
  });
});
