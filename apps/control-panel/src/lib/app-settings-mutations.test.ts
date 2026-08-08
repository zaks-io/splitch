import { describe, expect, it, vi } from "vitest";

vi.mock("./control-plane-app-settings-functions", () => ({
  deleteControlPanelApp: vi.fn(),
  updateControlPanelApp: vi.fn(),
}));

const { updateControlPanelApp } = await import("./control-plane-app-settings-functions");
const { renameApp } = await import("./app-settings-mutations");

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
});
