import { env as workerEnv } from "cloudflare:workers";
import type { ApprovalsClient, FlagsClient, PanelSegmentsClient } from "@splitch/control-plane-sdk";
import { getRequest } from "@tanstack/react-start/server";
import { controlPanelMutationBindings } from "./bindings";
import { createControlPanelAppSettingsClient } from "./control-plane-app-settings";
import {
  createControlPanelApprovalsClient,
  createControlPanelFlagsClient,
} from "./control-plane-apps";
import { createControlPanelSegmentsClient } from "./control-plane-segments";
import { loadSessionFromRequest } from "./session";
import { resyncSessionMemberships } from "./session-resync";

/**
 * The single place a Control Panel server function turns the browser session into
 * a delegated Control Plane client.
 *
 * Every caller gets the same 401 shape on an absent session, so an unauthenticated
 * request fails identically no matter which server function it reached — one
 * refusal, not one per handler that drifts (ADR-0036).
 */

type Unauthorized = {
  readonly ok: false;
  readonly result: {
    readonly ok: false;
    readonly status: 401;
    readonly error: {
      readonly code: "UNAUTHORIZED";
      readonly message: string;
      readonly details: Record<string, never>;
    };
  };
};

export type AuthorizedClient<T> = { readonly ok: true; readonly client: T } | Unauthorized;

/**
 * App Settings additionally needs the session itself: a slug rename or an App
 * delete invalidates the App list the session carries, so the handler has to
 * resync it before the operator's next navigation resolves against a handle that
 * no longer exists (`app-settings-outcome.ts`).
 */
export type AuthorizedAppSettings =
  | {
      readonly ok: true;
      readonly client: ReturnType<typeof createControlPanelAppSettingsClient>;
      readonly resyncSession: () => Promise<void>;
    }
  | Unauthorized;

export async function authorizedFlagsClient(
  environmentId: string,
): Promise<AuthorizedClient<FlagsClient>> {
  const authorized = await panelBindingContext();
  if (!authorized.ok) return authorized;
  const { bindings, actor } = authorized;
  return {
    ok: true,
    client: createControlPanelFlagsClient(
      bindings.CONTROL_PLANE_API,
      actor,
      environmentId,
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    ),
  };
}

export async function authorizedSegmentsClient(
  environmentId: string,
): Promise<AuthorizedClient<PanelSegmentsClient>> {
  const authorized = await panelBindingContext();
  if (!authorized.ok) return authorized;
  const { bindings, actor } = authorized;
  return {
    ok: true,
    client: createControlPanelSegmentsClient(
      bindings.CONTROL_PLANE_API,
      actor,
      environmentId,
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    ),
  };
}

/**
 * No Environment: an Approval Request is App-scoped and its Policy contexts can
 * span several Environments, so pinning the delegation to one would name a scope
 * the resource does not have.
 */
export async function authorizedApprovalsClient(): Promise<AuthorizedClient<ApprovalsClient>> {
  const authorized = await panelBindingContext();
  if (!authorized.ok) return authorized;
  const { bindings, actor } = authorized;
  return {
    ok: true,
    client: createControlPanelApprovalsClient(
      bindings.CONTROL_PLANE_API,
      actor,
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    ),
  };
}

/**
 * No Environment, for the same reason as Approvals: App name, slug, access list,
 * and deletion are App-level, so a delegation pinned to one Environment would
 * name a scope those resources do not have.
 */
export async function authorizedAppSettingsClient(): Promise<AuthorizedAppSettings> {
  const authorized = await panelBindingContext();
  if (!authorized.ok) return authorized;
  const { bindings, actor, loaded } = authorized;
  return {
    ok: true,
    client: createControlPanelAppSettingsClient(
      bindings.CONTROL_PLANE_API,
      actor,
      bindings.CONTROL_PANEL_DELEGATION_SECRET,
    ),
    resyncSession: async () => {
      await resyncSessionMemberships(bindings, loaded.tokenHash, loaded.session);
    },
  };
}

async function panelBindingContext() {
  const bindings = controlPanelMutationBindings(workerEnv);
  const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, getRequest());
  if (!loaded.ok) return unauthorized();
  return {
    ok: true as const,
    bindings,
    loaded,
    actor: { actorId: loaded.session.userId, sessionExpiresAt: loaded.session.expiresAt },
  };
}

function unauthorized(): Unauthorized {
  return {
    ok: false,
    result: {
      ok: false,
      status: 401,
      error: { code: "UNAUTHORIZED", message: "authentication required", details: {} },
    },
  };
}
