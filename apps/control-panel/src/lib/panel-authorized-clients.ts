import { env as workerEnv } from "cloudflare:workers";
import type { ApprovalsClient, FlagsClient } from "@splitch/control-plane-sdk";
import { getRequest } from "@tanstack/react-start/server";
import { controlPanelMutationBindings } from "./bindings";
import {
  createControlPanelApprovalsClient,
  createControlPanelFlagsClient,
} from "./control-plane-apps";
import { loadSessionFromRequest } from "./session";

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

async function panelBindingContext() {
  const bindings = controlPanelMutationBindings(workerEnv);
  const loaded = await loadSessionFromRequest(bindings.SESSION_STORE, getRequest());
  if (!loaded.ok) return unauthorized();
  return {
    ok: true as const,
    bindings,
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
