import type { createRepository } from "@splitch/db";
import { createPerformanceSpanRecorder } from "@splitch/observability/performance-spans";
import { createAnalysisResultsReader } from "./attention-analysis-reader";
import type { makeControlPlaneAuthResolver } from "./auth-resolver";
import { durableConfigStoreAccess } from "./config-store-access";
import { parseControlPanelBindingOperation } from "./control-panel-operation";
import { durableCredentialCacheWriterAccess } from "./credential-cache-writer-do";
import type { ControlPlaneApiEnv } from "./env";
import { makeSessionCacheMemberProfileResolver } from "./member-profile-cache";
import { panelAppSettingsRead } from "./panel-app-settings";
import { handleSignedPanelExperiments } from "./panel-experiments-route";
import { panelOverviewRead } from "./panel-overview";
import { panelSettingsRead } from "./panel-settings";
import { unauthorized } from "./unauthorized";

export type PanelProtocol = "none" | "signed" | "bounded-session";

export async function handleSignedControlPanelRequest(
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
  const configStore = durableConfigStoreAccess(env.CONFIG_STORE_WRITER, env.CONFIG_STORE);
  return panelOverviewRead(
    {
      repo,
      analysisResults: createAnalysisResultsReader(
        env.ANALYSIS_API,
        undefined,
        configStore,
        createPerformanceSpanRecorder(env),
      ),
    },
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
