import { describe, expect, it, vi } from "vitest";

vi.mock("./control-plane-conclusion-functions", () => ({ concludeControlPanelRun: vi.fn() }));
vi.mock("./use-experiment-detail-refresh", () => ({
  useExperimentDetailRefresh: vi.fn(),
}));

const { conclusionRecoveryApprovalId } = await import("./use-experiment-conclusion");

describe("Conclusion Approval recovery routing", () => {
  it.each(["pending", "stale"])("routes a %s response to recovery", (status) => {
    expect(conclusionRecoveryApprovalId({ id: "approval_1", status })).toBe("approval_1");
  });

  it.each(["applied", "declined"])("keeps a %s response on the completed view", (status) => {
    expect(conclusionRecoveryApprovalId({ id: "approval_1", status })).toBeUndefined();
  });
});
