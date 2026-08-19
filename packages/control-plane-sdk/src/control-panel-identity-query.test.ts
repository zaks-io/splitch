import { describe, expect, it } from "vitest";
import {
  issueControlPanelDelegation,
  verifyControlPanelDelegation,
} from "./control-panel-identity";

const NOW = 1_800_000_000;
const SECRET = "test-control-panel-delegation-secret-1234";
const OPERATION = { id: "apps_delete", appId: "app_1" } as const;

describe("Control Panel App delete delegation binding", () => {
  it("rejects dryRun-to-force replay while the matching dryRun request verifies", async () => {
    const preview = new Request("https://control-plane.internal/apps/app_1?dryRun=true", {
      method: "DELETE",
    });
    const force = new Request("https://control-plane.internal/apps/app_1?force=true", {
      method: "DELETE",
    });
    const delegation = await issueControlPanelDelegation(preview, OPERATION, "user_1", SECRET, {
      nowSeconds: NOW,
      sessionExpiresAt: NOW + 30,
      nonce: "nonce_apps_delete_123456",
    });

    await expect(
      verifyControlPanelDelegation(delegation, force, OPERATION, SECRET, NOW),
    ).resolves.toBeNull();
    await expect(
      verifyControlPanelDelegation(delegation, preview, OPERATION, SECRET, NOW),
    ).resolves.not.toBeNull();
  });
});
