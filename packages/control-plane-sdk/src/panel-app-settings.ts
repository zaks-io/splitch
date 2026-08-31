import type {
  App,
  AppMember,
  ResourceDeletePendingApproval,
  ResourceDeleteRemoved,
  UserRole,
} from "@splitch/contracts";
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
   * Present only when the viewer may grant App access AND may enumerate the
   * Organization roster. An empty array always means the roster is exhausted:
   * everyone in the Organization already has access.
   */
  candidates?: PanelAppAccessCandidate[];
  /**
   * True when the viewer may grant App access but may not enumerate the
   * Organization roster (they are not an Organization Owner or Admin), so
   * `candidates` is withheld rather than exhausted.
   */
  candidatesWithheld?: boolean;
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
    candidatesWithheld: z.boolean().optional(),
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
   * it, which is what the danger zone confirms against. A forced Panel delete
   * Reviews any Confirmation-gated children as the signed-in operator, then
   * resumes the cascade. The underlying Apps client still stops at Review so
   * CLI and MCP callers keep the safer default.
   */
  deleteApp(input: {
    appId: string;
    dryRun?: boolean;
    force?: boolean;
  }): Promise<PanelAppDeleteResult>;
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

export interface PanelAppDeleteProgress {
  readonly removed: readonly ResourceDeleteRemoved[];
  readonly appliedApprovalRequestIds: readonly string[];
}

export type PanelAppDeleteResult =
  | Extract<ControlPlaneOperationResult<AppsDeleteOutput>, { ok: true }>
  | (Extract<ControlPlaneOperationResult<AppsDeleteOutput>, { ok: false }> & {
      readonly partialDelete?: PanelAppDeleteProgress;
    });

type PendingAppDelete = Extract<AppsDeleteOutput, { deleted: false; force: true }>;

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
    deleteApp: (input) => deletePanelApp(sdk, input),
    addMember: ({ appId, userId, role }) => sdk.apps.members.add({ appId, userId, role }),
    updateMember: ({ appId, userId, role }) => sdk.apps.members.update({ appId, userId, role }),
    removeMember: ({ appId, userId }) => sdk.apps.members.remove({ appId, userId }),
  };
}

async function deletePanelApp(
  sdk: ReturnType<typeof createControlPlaneSdk>,
  input: { appId: string; dryRun?: boolean; force?: boolean },
): Promise<PanelAppDeleteResult> {
  const request = {
    appId: input.appId,
    ...(input.dryRun === true ? { dryRun: true } : {}),
    ...(input.force === true ? { force: true } : {}),
  };
  const result = await sdk.apps.delete(request);
  if (input.force !== true) return result;

  return continuePanelAppDelete(sdk, input.appId, request, result);
}

async function continuePanelAppDelete(
  sdk: ReturnType<typeof createControlPlaneSdk>,
  appId: string,
  request: { appId: string; dryRun?: boolean; force?: boolean },
  initialResult: ControlPlaneOperationResult<AppsDeleteOutput>,
): Promise<PanelAppDeleteResult> {
  const removed: ResourceDeleteRemoved[] = [];
  const appliedApprovalRequestIds: string[] = [];
  try {
    return await runPanelAppDelete(
      sdk,
      appId,
      request,
      initialResult,
      removed,
      appliedApprovalRequestIds,
    );
  } catch (error) {
    if (removed.length === 0 && appliedApprovalRequestIds.length === 0) throw error;
    return withDeleteProgress(
      {
        ok: false,
        status: 500,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message:
            error instanceof Error
              ? error.message
              : "App deletion stopped after partially deleting the App.",
          details: { fault: "panel_app_delete_partial_failure" },
        },
      },
      removed,
      appliedApprovalRequestIds,
    );
  }
}

async function runPanelAppDelete(
  sdk: ReturnType<typeof createControlPlaneSdk>,
  appId: string,
  request: { appId: string; dryRun?: boolean; force?: boolean },
  initialResult: ControlPlaneOperationResult<AppsDeleteOutput>,
  removed: ResourceDeleteRemoved[],
  appliedApprovalRequestIds: string[],
): Promise<PanelAppDeleteResult> {
  const reviewed = new Set<string>();
  let result = initialResult;
  while (result.ok) {
    const pending = pendingDeleteResult(result);
    if (!pending) return result;
    appendRemoved(removed, pending.removed);
    const refusal = await reviewDeleteApprovals(
      sdk,
      appId,
      pending.pendingApprovals,
      reviewed,
      appliedApprovalRequestIds,
    );
    if (refusal) return withDeleteProgress(refusal, removed, appliedApprovalRequestIds);
    result = await sdk.apps.delete(request);
  }
  return withDeleteProgress(result, removed, appliedApprovalRequestIds);
}

function appendRemoved(
  cumulative: ResourceDeleteRemoved[],
  next: readonly ResourceDeleteRemoved[],
): void {
  const known = new Set(cumulative.map(({ childType, id }) => `${childType}:${id}`));
  for (const removed of next) {
    const key = `${removed.childType}:${removed.id}`;
    if (known.has(key)) continue;
    cumulative.push(removed);
    known.add(key);
  }
}

function pendingDeleteResult(
  result: ControlPlaneOperationResult<AppsDeleteOutput>,
): PendingAppDelete | null {
  if (!result.ok || result.data.deleted || !("pendingApprovals" in result.data)) return null;
  return result.data;
}

async function reviewDeleteApprovals(
  sdk: ReturnType<typeof createControlPlaneSdk>,
  appId: string,
  approvals: readonly ResourceDeletePendingApproval[],
  reviewed: Set<string>,
  appliedApprovalRequestIds: string[],
): Promise<Extract<ControlPlaneOperationResult, { ok: false }> | null> {
  for (const approval of approvals) {
    if (reviewed.has(approval.approvalRequestId)) {
      throw new Error(
        `The Control Plane returned Approval Request ${approval.approvalRequestId} after Review already applied it.`,
      );
    }
    const review = await sdk.approvals.review({
      appId,
      id: approval.approvalRequestId,
      action: "approve_and_apply",
      idempotency_key: `panel_app_delete_${approval.approvalRequestId}`,
    });
    if (!review.ok) return review;
    reviewed.add(approval.approvalRequestId);
    appliedApprovalRequestIds.push(approval.approvalRequestId);
  }
  return null;
}

function withDeleteProgress(
  refusal: Extract<ControlPlaneOperationResult, { ok: false }>,
  removed: readonly ResourceDeleteRemoved[],
  appliedApprovalRequestIds: readonly string[],
): PanelAppDeleteResult {
  if (removed.length === 0 && appliedApprovalRequestIds.length === 0) return refusal;
  return {
    ...refusal,
    partialDelete: { removed, appliedApprovalRequestIds },
  };
}
