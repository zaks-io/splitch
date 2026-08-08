import type { App, AppMember, UserRole } from "@splitch/contracts";
import { AppMemberSchema, AppSchema, UserRoleSchema } from "@splitch/contracts";
import type {
  AppMembersAddOutput,
  AppMembersRemoveOutput,
  AppMembersUpdateOutput,
  AppsDeleteOutput,
  AppsUpdateOutput,
} from "@splitch/contracts/route-types";
import { z } from "zod";
import { createControlPlaneSdk } from "./index";
import type { ControlPlaneOperationResult } from "./operation-result";
import { parseControlPlaneResponse } from "./operation-result";

/**
 * App Settings (SPL-114): the App half of the Settings screen.
 *
 * One composed binding read backs the whole screen, so the Panel renders from a
 * single authorization decision rather than four independently-authorized calls
 * whose answers could disagree. `viewerRole` is the role the Worker read LIVE
 * while authorizing this call, never a session claim, and it is what the screen
 * enables or disables actions from.
 */

/**
 * One Flag's App-level definition. Primitives only, like every other Panel read:
 * a Variant value can be an arbitrary JSON object, and the server-function
 * boundary neither serializes nor type-checks those, so the value is rendered
 * once here and crosses as the text the screen shows.
 *
 * `defaultVariantName` is null only when `defaultVariantId` names a Variant that
 * is not in the catalog, which is corrupt data. It is modelled rather than
 * papered over with the first Variant, and the screen says so out loud
 * (ADR-0036).
 */
export interface PanelAppCatalogVariant {
  id: string;
  name: string;
  value: string;
}

export interface PanelAppCatalogFlag {
  id: string;
  key: string;
  name: string;
  variants: PanelAppCatalogVariant[];
  defaultVariantName: string | null;
}

export interface PanelAppFlagCatalog {
  items: PanelAppCatalogFlag[];
  readTruncated: boolean;
  readLimit: number;
}

/**
 * Someone in the owning Organization who does not have access to this App yet.
 *
 * The screen grants access by picking a person, never by typing a user id: App
 * access is granted from inside the Organization that owns the App, so the set
 * of people who could be granted it is exactly this list and the Panel has no
 * business asking an operator to transcribe an internal identifier.
 */
export interface PanelAppAccessCandidate {
  userId: string;
  email: string | null;
  orgRole: UserRole;
}

export interface PanelAppSettings {
  app: App;
  viewerRole: UserRole;
  members: AppMember[];
  /**
   * Present only when the viewer may grant App access. An empty array means the
   * viewer may grant access, but every Organization member already has it.
   */
  candidates?: PanelAppAccessCandidate[];
  flags: PanelAppFlagCatalog;
}

/** The App role-matrix predicate shared by the Worker and Control Panel. */
export function canGrantAppAccess(viewerRole: UserRole): boolean {
  return viewerRole === "owner" || viewerRole === "admin";
}

export const PanelAppSettingsSchema = z
  .object({
    app: AppSchema,
    viewerRole: UserRoleSchema,
    members: z.array(AppMemberSchema),
    candidates: z
      .array(
        z
          .object({
            userId: z.string(),
            email: z.string().nullable(),
            orgRole: UserRoleSchema,
          })
          .strict(),
      )
      .optional(),
    flags: z.object({
      items: z.array(
        z
          .object({
            id: z.string(),
            key: z.string(),
            name: z.string(),
            variants: z.array(
              z.object({ id: z.string(), name: z.string(), value: z.string() }).strict(),
            ),
            defaultVariantName: z.string().nullable(),
          })
          .strict(),
      ),
      readTruncated: z.boolean(),
      readLimit: z.number(),
    }),
  })
  .strict();

export interface PanelAppSettingsClient {
  read(input: { appId: string }): Promise<ControlPlaneOperationResult<PanelAppSettings>>;
  updateApp(input: {
    appId: string;
    name?: string;
    key?: string;
  }): Promise<ControlPlaneOperationResult<AppsUpdateOutput>>;
  /**
   * `dryRun` names exactly what a delete would destroy without destroying any of
   * it, which is what the danger zone confirms against. `force` cascades that
   * same tree; the two are mutually exclusive in the contract.
   */
  deleteApp(input: {
    appId: string;
    dryRun?: boolean;
    force?: boolean;
  }): Promise<ControlPlaneOperationResult<AppsDeleteOutput>>;
  addMember(input: {
    appId: string;
    userId: string;
    role: UserRole;
  }): Promise<ControlPlaneOperationResult<AppMembersAddOutput>>;
  updateMember(input: {
    appId: string;
    userId: string;
    role: UserRole;
  }): Promise<ControlPlaneOperationResult<AppMembersUpdateOutput>>;
  removeMember(input: {
    appId: string;
    userId: string;
  }): Promise<ControlPlaneOperationResult<AppMembersRemoveOutput>>;
}

export function createPanelAppSettingsClient(options: {
  fetch: typeof fetch;
  baseUrl?: string;
}): PanelAppSettingsClient {
  const baseUrl = options.baseUrl ?? "https://control-plane.internal";
  const sdk = createControlPlaneSdk({ baseUrl, fetch: options.fetch });

  return {
    async read({ appId }) {
      const path = `/control-panel/apps/${encodeURIComponent(appId)}/settings`;
      const response = await options.fetch(new URL(path, baseUrl), { method: "GET" });
      return parseControlPlaneResponse<PanelAppSettings>(response, "app_settings_get", {
        safeParse: (input) => PanelAppSettingsSchema.safeParse(input),
      });
    },
    updateApp: ({ appId, name, key }) =>
      sdk.apps.update({
        appId,
        ...(name !== undefined ? { name } : {}),
        ...(key !== undefined ? { key } : {}),
      }),
    deleteApp: ({ appId, dryRun, force }) =>
      sdk.apps.delete({
        appId,
        ...(dryRun === true ? { dryRun } : {}),
        ...(force === true ? { force } : {}),
      }),
    addMember: ({ appId, userId, role }) => sdk.apps.members.add({ appId, userId, role }),
    updateMember: ({ appId, userId, role }) => sdk.apps.members.update({ appId, userId, role }),
    removeMember: ({ appId, userId }) => sdk.apps.members.remove({ appId, userId }),
  };
}
