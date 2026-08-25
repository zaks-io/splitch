import { WorkerEntrypoint } from "cloudflare:workers";
import { createHealthResponse, parsePlatformTarget } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import {
  createWorkerFaultReporter,
  createWorkerObservability,
  workerObservabilityWithWaitUntil,
  wrapWorkerHandler,
} from "@splitch/observability/worker";
import {
  McpDelegationReplayDurableObject,
  makeDurableMcpDelegationReplayGuard,
  makeMcpDelegationAuthResolver,
} from "@splitch/worker-runtime";
import { createApp } from "./app";
import { approvalArchiveStoreFromEnv } from "./approval-archive-tinybird";
import { createAnalysisResultsReader } from "./attention-analysis-reader";
import { authJwksUri } from "./auth-jwks-config";
import { makeControlPlaneAuthResolver } from "./auth-resolver";
import { ConfigStoreDurableObject, durableConfigStoreAccess } from "./config-store-do";
import { parseControlPanelBindingOperation } from "./control-panel-operation";
import {
  boundedPanelSessionEnabled,
  controlPanelAuthOptions,
  requiredMcpDelegationSecret,
  requiredMcpReplayBinding,
} from "./control-plane-runtime-config";
import { CredentialCacheBackfillDurableObject } from "./credential-cache-backfill-do";
import {
  CredentialCacheWriterDurableObject,
  durableCredentialCacheWriterAccess,
} from "./credential-cache-writer-do";
import type { ControlPlaneApiEnv } from "./env";
import { createHoldoverWriteOutboxCleanup } from "./holdover-write-outbox-cleanup";
import { handleCredentialCacheBackfillGate, handleLiveUpdateTestControl } from "./internal-routes";
import { makeHttpJwksFetcher, makeJwksVerifier } from "./jwks-verify";
import { makeSessionCacheMemberProfileResolver } from "./member-profile-cache";
import { panelAppSettingsRead } from "./panel-app-settings";
import { PanelDelegationReplayDurableObject } from "./panel-delegation-replay-do";
import { handleSignedPanelExperiments } from "./panel-experiments-route";
import { panelOverviewRead } from "./panel-overview";
import { panelSettingsRead } from "./panel-settings";
import { rateLimiterForTarget } from "./rate-limit";
import { runSnapshotDeliveryFromEnv } from "./run-snapshot";
import { runControlPlaneScheduled } from "./scheduled";
import { makeSessionStore } from "./session-store";
import { unauthorized } from "./unauthorized";

const service = "splitch-control-plane-api";
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
    return boundedPanelHandler.fetch(
      request as Parameters<typeof boundedPanelHandler.fetch>[0],
      this.env,
      this.ctx,
    );
  }
}

/** Binding-only entrypoint for one-operation MCP delegations. */
export class McpEntrypoint extends WorkerEntrypoint<ControlPlaneApiEnv> {
  override async fetch(request: Request): Promise<Response> {
    return mcpHandler.fetch(request as Parameters<typeof mcpHandler.fetch>[0], this.env, this.ctx);
  }
}

/** Binding-only V2 entrypoint used by the Control Panel for signed least-privilege delegation. */
export class SignedControlPanelEntrypoint extends WorkerEntrypoint<ControlPlaneApiEnv> {
  override async fetch(request: Request): Promise<Response> {
    return signedPanelHandler.fetch(
      request as Parameters<typeof signedPanelHandler.fetch>[0],
      this.env,
      this.ctx,
    );
  }
}

type PanelProtocol = "none" | "signed" | "bounded-session";
type AuthMode = PanelProtocol | "mcp";

function bindingHandler(authMode: Exclude<AuthMode, "none">) {
  return wrapWorkerHandler(
    {
      async fetch(request, env, ctx): Promise<Response> {
        if (authMode === "bounded-session" && !boundedPanelSessionEnabled(env)) {
          return new Response("not found", { status: 404 });
        }
        if (authMode !== "mcp" && !parseControlPanelBindingOperation(request)) {
          return new Response("not found", { status: 404 });
        }
        return handleRequest(request, env, ctx, authMode);
      },
    } satisfies ExportedHandler<ControlPlaneApiEnv>,
    { surface: "control-plane-api" },
  );
}

async function handleRequest(
  request: Request,
  env: ControlPlaneApiEnv,
  ctx: ExecutionContext,
  authMode: AuthMode = "none",
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" || url.pathname === "/") {
    const response = Response.json(
      createHealthResponse(
        service,
        parsePlatformTarget(env.SPLITCH_PLATFORM_TARGET),
        env.SPLITCH_DEPLOYED_COMMIT_SHA,
      ),
    );
    if (env.SPLITCH_LOCAL_E2E_RUN_ID) {
      response.headers.set("x-splitch-local-e2e-run-id", env.SPLITCH_LOCAL_E2E_RUN_ID);
    }
    return response;
  }
  if (url.pathname.startsWith("/internal/credential-cache-backfill")) {
    return handleCredentialCacheBackfillGate(request, env, url);
  }
  const liveUpdateTestControl = await handleLiveUpdateTestControl(request, env, url);
  if (liveUpdateTestControl) return liveUpdateTestControl;

  const controlPlaneAudience = env.CONTROL_PLANE_ORIGIN ?? url.origin;
  const jwksUri = authJwksUri(env);
  const verifier = makeJwksVerifier({
    fetchJwks: makeHttpJwksFetcher(jwksUri),
    controlPlaneAudience,
  });

  const repo = createRepository(env.DB);
  const panelProtocol = authMode === "mcp" ? "none" : authMode;
  const panelAuthResolver = makeControlPlaneAuthResolver(
    {
      verifier,
      sessions: makeSessionStore(env.SESSION_STORE),
    },
    controlPanelAuthOptions(env, repo, panelProtocol),
  );
  const authResolver =
    authMode === "mcp"
      ? makeMcpDelegationAuthResolver({
          surface: "control-plane-api",
          secret: requiredMcpDelegationSecret(env.MCP_CONTROL_PLANE_DELEGATION_SECRET),
          replayGuard: makeDurableMcpDelegationReplayGuard(
            requiredMcpReplayBinding(env.MCP_DELEGATION_REPLAY),
          ),
        })
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
  const app = createApp({
    authResolver,
    rateLimiter: rateLimiterForTarget(
      env.SPLITCH_PLATFORM_TARGET,
      env.CONTROL_PLANE_ACTOR_RATE_LIMITER,
    ),
    repo,
    credentialStore: env.CREDENTIAL_STORE,
    credentialCacheWriter: durableCredentialCacheWriterAccess(env.CREDENTIAL_CACHE_WRITER),
    configStore: durableConfigStoreAccess(env.CONFIG_STORE_WRITER),
    eventDefinitionStore: env.CONFIG_STORE,
    runSnapshotDelivery: {
      ...runSnapshotDeliveryFromEnv(env),
      onFault: (detail) => reportRunSnapshotFault(env, ctx, detail),
    },
    logger: console,
    memberProfileResolver: makeSessionCacheMemberProfileResolver(env.SESSION_STORE),
    observability: createWorkerObservability(
      env,
      workerObservabilityWithWaitUntil("control-plane-api", ctx),
    ),
    analysisResults: createAnalysisResultsReader(env.ANALYSIS_API),
    delegationBindings: {
      "analysis-api": env.ANALYSIS_API,
      "evaluation-api": env.EVALUATION_API,
    },
    approvalArchiveStore: approvalArchiveStoreFromEnv(env),
    holdoverWriteOutboxCleanup: createHoldoverWriteOutboxCleanup(env.EVALUATION_API),
  });

  return app.fetch(request, env);
}

async function handleSignedControlPanelRequest(
  request: Request,
  env: ControlPlaneApiEnv,
  protocol: PanelProtocol,
  authResolver: ReturnType<typeof makeControlPlaneAuthResolver>,
  repo: ReturnType<typeof createRepository>,
): Promise<Response | null> {
  return (
    (await handleSignedPanelExperiments(request, env, protocol, authResolver)) ??
    (await handleSignedPanelOverview(request, env, protocol, authResolver, repo)) ??
    (await handleSignedPanelAppSettings(request, env, protocol, authResolver, repo)) ??
    handleSignedPanelSettings(request, env, protocol, authResolver, repo)
  );
}

async function handleSignedPanelAppSettings(
  request: Request,
  env: ControlPlaneApiEnv,
  protocol: PanelProtocol,
  authResolver: ReturnType<typeof makeControlPlaneAuthResolver>,
  repo: ReturnType<typeof createRepository>,
): Promise<Response | null> {
  if (protocol !== "signed") return null;
  const operation = parseControlPanelBindingOperation(request);
  if (operation?.id !== "app_settings_get") return null;
  const auth = await authResolver(request);
  if (!auth.ok) return unauthorized();
  return panelAppSettingsRead(
    { repo, memberProfileResolver: makeSessionCacheMemberProfileResolver(env.SESSION_STORE) },
    { appId: operation.appId, actorId: auth.principal.id },
    request,
  );
}

async function handleSignedPanelOverview(
  request: Request,
  env: ControlPlaneApiEnv,
  protocol: PanelProtocol,
  authResolver: ReturnType<typeof makeControlPlaneAuthResolver>,
  repo: ReturnType<typeof createRepository>,
): Promise<Response | null> {
  if (protocol !== "signed") return null;
  const operation = parseControlPanelBindingOperation(request);
  if (operation?.id !== "overview_get") return null;
  const auth = await authResolver(request);
  if (!auth.ok) return unauthorized();
  return panelOverviewRead(
    { repo, analysisResults: createAnalysisResultsReader(env.ANALYSIS_API) },
    {
      actorId: auth.principal.id,
      appId: operation.appId,
      environmentId: operation.environmentId,
    },
  );
}

async function handleSignedPanelSettings(
  request: Request,
  env: ControlPlaneApiEnv,
  protocol: PanelProtocol,
  authResolver: ReturnType<typeof makeControlPlaneAuthResolver>,
  repo: ReturnType<typeof createRepository>,
): Promise<Response | null> {
  // Keep this binding-only read narrow like handleSignedPanelExperiments; mutation
  // routes still inherit the full createApp rate-limit and observability stack below.
  if (protocol !== "signed") return null;
  const operation = parseControlPanelBindingOperation(request);
  if (operation?.id !== "settings_get") return null;
  const auth = await authResolver(request);
  if (!auth.ok) return unauthorized();
  return panelSettingsRead(
    {
      repo,
      credentialStore: env.CREDENTIAL_STORE,
      credentialCacheWriter: durableCredentialCacheWriterAccess(env.CREDENTIAL_CACHE_WRITER),
    },
    operation,
    auth.principal,
  );
}

function reportRunSnapshotFault(
  env: ControlPlaneApiEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  detail: Record<string, unknown>,
): void {
  createWorkerFaultReporter(env, workerObservabilityWithWaitUntil("control-plane-api", ctx))(
    "run_snapshot_unshipped",
    detail,
  );
}

export {
  ConfigStoreDurableObject,
  CredentialCacheBackfillDurableObject,
  CredentialCacheWriterDurableObject,
  McpDelegationReplayDurableObject,
  PanelDelegationReplayDurableObject,
};
