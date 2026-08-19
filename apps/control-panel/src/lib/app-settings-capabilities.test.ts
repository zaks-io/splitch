import { describe, expect, it } from "vitest";
import { appSettingsCapabilities, grantableRoles } from "./app-settings-capabilities";
import { isDeleteConfirmed } from "./app-delete-confirmation";

/**
 * The App role matrix as the screen offers it. The Worker still refuses on its
 * own terms; this decides what is offered, so an over-permissive row here shows
 * an operator a control that can only fail.
 */
describe("App Settings capabilities", () => {
  it("gives an owner every App-level action", () => {
    expect(appSettingsCapabilities("owner")).toEqual({
      canRename: true,
      canGrantAccess: true,
      canGrantOwner: true,
      canManageAccess: true,
      canDelete: true,
    });
  });

  it("lets an admin rename and grant access, but not mint owners, change roles, or delete", () => {
    expect(appSettingsCapabilities("admin")).toEqual({
      canRename: true,
      canGrantAccess: true,
      canGrantOwner: false,
      canManageAccess: false,
      canDelete: false,
    });
  });

  it("gives a member no App-level write at all", () => {
    expect(appSettingsCapabilities("member")).toEqual({
      canRename: false,
      canGrantAccess: false,
      canGrantOwner: false,
      canManageAccess: false,
      canDelete: false,
    });
  });

  it("offers owner as a grantable role only to an owner", () => {
    expect(grantableRoles(appSettingsCapabilities("owner"))).toEqual(["owner", "admin", "member"]);
    expect(grantableRoles(appSettingsCapabilities("admin"))).toEqual(["admin", "member"]);
  });
});

describe("delete confirmation", () => {
  it("accepts the App's URL slug typed exactly", () => {
    expect(isDeleteConfirmed("checkout-api", "checkout-api")).toBe(true);
  });

  it("rejects everything that is merely close", () => {
    for (const typed of [
      "",
      " ",
      "checkout-api ",
      " checkout-api",
      "Checkout-API",
      "checkout",
      "Checkout API",
      "delete",
      "yes",
    ]) {
      expect(isDeleteConfirmed(typed, "checkout-api")).toBe(false);
    }
  });
});
