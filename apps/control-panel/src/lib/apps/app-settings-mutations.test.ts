import { describe, expect, it, vi } from "vitest";

vi.mock("#lib/apps/control-plane-app-settings-functions", () => ({
  deleteControlPanelApp: vi.fn(),
  updateControlPanelApp: vi.fn(),
}));

const { deleteControlPanelApp, updateControlPanelApp } = await import(
  "#lib/apps/control-plane-app-settings-functions"
);
const { destroyApp, renameApp } = await import("#lib/apps/app-settings-mutations");

describe("App Settings mutation transport failures", () => {
  it("does not claim a rename left Control Plane state unchanged when no answer arrived", async () => {
    vi.mocked(updateControlPanelApp).mockRejectedValueOnce(new TypeError("response was lost"));

    await expect(
      renameApp({
        appId: "app_checkout",
        currentKey: "checkout",
        key: "checkout-renamed",
        name: "Checkout",
      }),
    ).resolves.toEqual({
      kind: "refused",
      message: "The Control Plane did not answer. This App may or may not have been renamed.",
    });
  });

  it("preserves partial progress when the delete cascade stops on an invariant", async () => {
    vi.mocked(deleteControlPanelApp).mockResolvedValueOnce({
      ok: false,
      status: 500,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "The Control Plane returned an Approval Request after Review already applied it.",
        details: { fault: "panel_app_delete_repeated_approval" },
      },
      partialDelete: {
        removed: [{ childType: "experiments", id: "exp_checkout" }],
        appliedApprovalRequestIds: ["apr_checkout"],
      },
    } as Awaited<ReturnType<typeof deleteControlPanelApp>>);

    await expect(destroyApp("app_checkout")).resolves.toEqual({
      kind: "partially-deleted",
      message: "The Control Plane returned an Approval Request after Review already applied it.",
      removedCount: 2,
    });
  });

  it("keeps post-boundary cleanup failures actionable", async () => {
    vi.mocked(deleteControlPanelApp).mockResolvedValueOnce({
      ok: false,
      status: 503,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Exposure status cleanup is unavailable",
        details: { retryAfterMs: 30_000 },
      },
      appDeleted: true,
    } as Awaited<ReturnType<typeof deleteControlPanelApp>>);

    await expect(destroyApp("app_checkout")).resolves.toEqual({
      kind: "cleanup-pending",
      message: "Exposure status cleanup is unavailable",
    });
  });
});
