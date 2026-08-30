import type { UserRole } from "@splitch/contracts";
import { canGrantAppAccess } from "@splitch/control-plane-sdk/panel-app-settings";

/**
 * The App role matrix, mirrored from
 * `docs/spec/control-plane/organization-and-membership.md`.
 *
 * This is presentation only. The Worker rechecks live App membership on every
 * call and owns every refusal (ADR-0023); this exists so the screen does not
 * offer an action it already knows will be refused. `viewerRole` is the role the
 * Worker read while authorizing THIS read, never a session claim.
 */
export interface AppSettingsCapabilities {
  /** Rename the App or change its URL slug: owner, admin. */
  readonly canRename: boolean;
  /** Grant App access: owner, admin. */
  readonly canGrantAccess: boolean;
  /**
   * Grant the `owner` role specifically: owner only. An admin who could mint an
   * owner would walk straight past the owner-only role-change and revoke gates.
   */
  readonly canGrantOwner: boolean;
  /** Change an App role or revoke access: owner only. */
  readonly canManageAccess: boolean;
  /** Delete the App: owner only. */
  readonly canDelete: boolean;
}

export function appSettingsCapabilities(viewerRole: UserRole): AppSettingsCapabilities {
  const isOwner = viewerRole === "owner";
  const isAdmin = viewerRole === "admin";
  return {
    canRename: isOwner || isAdmin,
    canGrantAccess: canGrantAppAccess(viewerRole),
    canGrantOwner: isOwner,
    canManageAccess: isOwner,
    canDelete: isOwner,
  };
}

/** The roles this viewer may hand out, in matrix order. */
export function grantableRoles(capabilities: AppSettingsCapabilities): UserRole[] {
  return capabilities.canGrantOwner ? ["owner", "admin", "member"] : ["admin", "member"];
}

export const APP_ROLE_LABELS: Record<UserRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};
