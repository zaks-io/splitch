import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type ConvexExposureVerificationBatchRequest,
  type ConvexExposureVerificationRequest,
  routesDelegatedTo,
} from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import { wrapWorkerHandler } from "@splitch/observability/worker";
import {
  type DelegatedIdentity,
  delegatedAuthResolver,
  delegatedIdentityFor,
  McpDelegationReplayDurableObject,
  makeDurableMcpDelegationReplayGuard,
  makeMcpDelegationAuthResolver,
  notDelegatedResponse,
} from "@splitch/worker-runtime";
import { authJwksUri } from "./auth-jwks-config";
import { makeControlPlaneAuthResolver } from "./auth-resolver";
import { ConfigStoreDurableObject } from "./config-store-do";
import { parseControlPanelBindingOperation } from "./control-panel-operation";
import { handleControlPlaneAppRequest } from "./control-plane-app-request";
import {
  boundedPanelSessionEnabled,
  controlPanelAuthOptions,
  requiredMcpDelegationSecret,
  requiredMcpReplayBinding,
} from "./control-plane-runtime-config";
import { CredentialCacheBackfillDurableObject } from "./credential-cache-backfill-do";
import { CredentialCacheWriterDurableObject } from "./credential-cache-writer-do";
import type { ControlPlaneApiEnv } from "./env";
import {
  loadCloudflareExposureVerificationConfigFromEnv,
  loadCloudflareExposureVerificationConfigsFromEnv,
  loadConvexExposureVerificationConfigFromEnv,
  loadConvexExposureVerificationConfigsFromEnv,
  resetCompromisedAppIdentityFromEnv,
} from "./exposure-verification-entrypoint";
import { controlPlaneHealthResponse } from "./health";
import { handleCredentialCacheBackfillGate, handleLiveUpdateTestControl } from "./internal-routes";
import { makeCachedJwksVerifier } from "./jwks-verify";
import { PanelDelegationReplayDurableObject } from "./panel-delegation-replay-do";
import { runControlPlaneScheduled } from "./scheduled";
import { makeSessionStore } from "./session-store";
import {
  handleSignedControlPanelRequest,
  type PanelProtocol,
} from "./signed-control-panel-request";
import {
  makeTokenMembershipAccess,
  resolveMcpMembershipScopes,
  withBearerMembershipCheck,
} from "./token-membership";

const handler = {
  async fetch(request, env, ctx): Promise<Response> {
    return handleRequest(request, env, ctx);
  },

  scheduled(event, env, ctx): void {
    runControlPlaneScheduled(event, env, ctx);
  },
} satisfies ExportedHandler<ControlPlaneApiEnv>;

export default wrapWorkerHandler(handler, { surface: "control-plane-api" });

const boundedPanelHandler = bindingHandler("bounded-session");
const mcpHandler = bindingHandler("mcp");
const signedPanelHandler = bindingHandler("signed");

/** Bounded bridge for the predecessor Panel's session-handle binding protocol. */
export class ControlPanelEntrypoint extends WorkerEntrypoint<ControlPlaneApiEnv> {
  override async fetch(request: Request): Promise<Response> {
    return wrapWorkerHandler(boundedPanelHandler, { surface: "control-plane-api" }).fetch(
      request as Parameters<typeof boundedPanelHandler.fetch>[0],
      this.env,
      this.ctx,
    );
  }
}

/** Binding-only entrypoint for one-operation MCP delegations. */
export class McpEntrypoint extends WorkerEntrypoint<ControlPlaneApiEnv> {
  override async fetch(request: Request): Promise<Response> {
    return wrapWorkerHandler(mcpHandler, { surface: "control-plane-api" }).fetch(
      request as Parameters<typeof mcpHandler.fetch>[0],
      this.env,
      this.ctx,
    );
  }

  async resolveMcpMembershipScopes(userId: string): Promise<string[]> {
    return resolveMcpMembershipScopes(
      makeTokenMembershipAccess(createRepository(this.env.DB)),
      userId,
    );
  }
}

/** Binding-only V2 entrypoint used by the Control Panel for signed least-privilege delegation. */
export class SignedControlPanelEntrypoint extends WorkerEntrypoint<ControlPlaneApiEnv> {
  override async fetch(request: Request): Promise<Response> {
    return wrapWorkerHandler(signedPanelHandler, { surface: "control-plane-api" }).fetch(
      request as Parameters<typeof signedPanelHandler.fetch>[0],
      this.env,
      this.ctx,
    );
  }
}

const evaluationDelegatedRoutes = routesDelegatedTo("control-plane-api").filter(
  (route) => route.auth === "api-key",
);

const evaluationHandler = {
  async fetch(request, env, ctx): Promise<Response> {
    const identity = delegatedIdentityFor(request, evaluationDelegatedRoutes);
    if (!identity) return notDelegatedResponse(request);
    return handleRequest(request, env, ctx, { kind: "evaluation", identity });
  },
} satisfies ExportedHandler<ControlPlaneApiEnv>;

/** Binding-only entrypoint for API-Key Convex routes surfaced by Evaluation. */
export class EvaluationEntrypoint extends WorkerEntrypoint<ControlPlaneApiEnv> {
  override async fetch(request: Request): Promise<Response> {
    return wrapWorkerHandler(evaluationHandler, { surface: "control-plane-api" }).fetch(
      request as Parameters<typeof evaluationHandler.fetch>[0],
      this.env,
      this.ctx,
    );
  }

  loadConvexExposureVerificationConfigs(input: ConvexExposureVerificationBatchRequest) {
    return loadConvexExposureVerificationConfigsFromEnv(this.env, input);
  }

  loadConvexExposureVerificationConfig(input: ConvexExposureVerificationRequest) {
    return loadConvexExposureVerificationConfigFromEnv(this.env, input);
  }

  loadCloudflareExposureVerificationConfigs(input: ConvexExposureVerificationBatchRequest) {
    return loadCloudflareExposureVerificationConfigsFromEnv(this.env, input);
  }

  loadCloudflareExposureVerificationConfig(input: ConvexExposureVerificationRequest) {
    return loadCloudflareExposureVerificationConfigFromEnv(this.env, input);
  }

  resetCompromisedAppIdentity(appId: string, resetId: string): Promise<string> {
    return resetCompromisedAppIdentityFromEnv(this.env, appId, resetId);
  }
}

type AuthMode = PanelProtocol | "mcp";

function bindingHandler(authMode: Exclude<AuthMode, "none">) {
  return {
    async fetch(request, env, ctx): Promise<Response> {
      if (authMode === "bounded-session" && !boundedPanelSessionEnabled(env)) {
        return new Response("not found", { status: 404 });
      }
      if (authMode !== "mcp" && !parseControlPanelBindingOperation(request)) {
        return new Response("not found", { status: 404 });
      }
      return handleRequest(request, env, ctx, authMode);
    },
  } satisfies ExportedHandler<ControlPlaneApiEnv>;
}

type BindingAuthority = { kind: "evaluation"; identity: DelegatedIdentity };
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This is the single Worker door switch and keeps each binding authority visible.
async function handleRequest(
  request: Request,
  env: ControlPlaneApiEnv,
  ctx: ExecutionContext,
  authMode: AuthMode | BindingAuthority = "none",
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" || url.pathname === "/") {
    return controlPlaneHealthResponse(env);
  }
  if (url.pathname.startsWith("/internal/credential-cache-backfill")) {
    return handleCredentialCacheBackfillGate(request, env, url);
  }
  const liveUpdateTestControl = await handleLiveUpdateTestControl(request, env, url);
  if (liveUpdateTestControl) return liveUpdateTestControl;

  const controlPlaneAudience = env.CONTROL_PLANE_ORIGIN ?? url.origin;
  const jwksUri = authJwksUri(env);
  const verifier = makeCachedJwksVerifier({
    jwksUri,
    controlPlaneAudience,
  });

  const repo = createRepository(env.DB);
  const membershipAccess = makeTokenMembershipAccess(repo);
  const panelProtocol: PanelProtocol =
    typeof authMode === "object" || authMode === "mcp" ? "none" : authMode;
  const panelAuthResolver = makeControlPlaneAuthResolver(
    {
      verifier,
      sessions: makeSessionStore(env.SESSION_STORE),
      membershipAccess,
    },
    controlPanelAuthOptions(env, repo, panelProtocol),
  );
  const authResolver =
    typeof authMode === "object"
      ? delegatedAuthResolver(authMode.identity)
      : authMode === "mcp"
        ? withBearerMembershipCheck(
            makeMcpDelegationAuthResolver({
              surface: "control-plane-api",
              secret: requiredMcpDelegationSecret(env.MCP_CONTROL_PLANE_DELEGATION_SECRET),
              replayGuard: makeDurableMcpDelegationReplayGuard(
                requiredMcpReplayBinding(env.MCP_DELEGATION_REPLAY),
              ),
            }),
            membershipAccess,
          )
        : panelAuthResolver;
  const panelResponse = await handleSignedControlPanelRequest(
    request,
    env,
    panelProtocol,
    authResolver,
    repo,
  );
  if (panelResponse) return panelResponse;
  // When authMode === "mcp", this same app mounts every Control Plane route under the MCP
  // resolver; operationId, method, target, and bodySha256 credential pins confine each call.
  return handleControlPlaneAppRequest({
    request,
    env,
    ctx,
    authResolver,
    repo,
    delegated: typeof authMode === "object",
  });
}

export {
  ConfigStoreDurableObject,
  CredentialCacheBackfillDurableObject,
  CredentialCacheWriterDurableObject,
  McpDelegationReplayDurableObject,
  PanelDelegationReplayDurableObject,
};
