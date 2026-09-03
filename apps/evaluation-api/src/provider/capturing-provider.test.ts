import { describe, expect, it } from "vitest";
import {
  experimentConfig,
  flagConfig,
  RecordingProvider,
} from "../evaluate/evaluate-path-test-fixtures";
import { CapturingProvider } from "./capturing-provider";

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
});
