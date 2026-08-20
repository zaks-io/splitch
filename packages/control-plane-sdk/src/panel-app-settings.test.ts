import { describe, expect, it } from "vitest";
import {
  canGrantAppAccess,
  type PanelAppSettings,
  PanelAppSettingsSchema,
} from "./panel-app-settings";

const settings: Omit<PanelAppSettings, "candidates"> = {
  app: {
    id: "app_checkout",
    organizationId: "org_acme",
    name: "Checkout",
    key: "checkout",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  },
  viewerRole: "member",
  members: [],
  flags: { items: [], readTruncated: false, readLimit: 200 },
};

describe("Panel App Settings contract", () => {
  it("distinguishes a withheld candidate roster from a visible empty roster", () => {
    const nonGranter = PanelAppSettingsSchema.parse(settings);
    const withheld = PanelAppSettingsSchema.parse({ ...settings, candidatesWithheld: true });
    const empty = PanelAppSettingsSchema.parse({ ...settings, candidates: [] });

    expect(nonGranter).not.toHaveProperty("candidates");
    expect(nonGranter).not.toHaveProperty("candidatesWithheld");
    expect(withheld).not.toHaveProperty("candidates");
    expect(withheld.candidatesWithheld).toBe(true);
    expect(empty.candidates).toEqual([]);
  });

  it("allows only owners and admins to grant App access", () => {
    expect(
      (["owner", "admin", "member"] as const).filter((role) => canGrantAppAccess(role)),
    ).toEqual(["owner", "admin"]);
  });
});
