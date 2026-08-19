import { buildOpenApiDocument } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import {
  type AuthResolver,
  createRegistrar,
  type RateLimiter,
  type Registrar,
  type RegistrarDeps,
} from "@splitch/worker-runtime";
import { Hono } from "hono";
import { makeAppEnvironmentHandlers } from "./app-environment-handlers";
import { makeAppMemberHandlers } from "./app-member-handlers";
import { makeOtherApprovalApplication } from "./approval-application";
import { makeApprovalHandlers } from "./approval-handlers";
import type { AnalysisResultsReader } from "./attention-analysis-reader";
import { unavailableAnalysisResults } from "./attention-analysis-reader";
import { makeAttentionRollupHandler } from "./attention-rollup";
import type { ConfigStoreAccess } from "./config-store-do";
import type { CredentialCacheWriterAccess } from "./credential-cache";
import { makeCredentialHandlers } from "./credential-handlers";
import { type DelegationBindings, mountDelegatedRoutes } from "./delegated-routes";
import { makeEntityPrivacyDeleteHandler } from "./entity-privacy-delete-handler";
import { registerEventDefinitionRoutes } from "./event-definition-handlers";
import { makeExperimentHandlers } from "./experiment-handlers";
import { appEnvironmentCleanupDeps } from "./app-environment-cleanup-deps";
import type { EnvironmentExposureStatusCleanup } from "./environment-exposure-status-cleanup";
import type { HoldoverWriteOutboxCleanup } from "./holdover-write-outbox-cleanup";
import { diagnosableHandlers } from "./flag-config-policy";
import { makeFlagDefinitionHandlers } from "./flag-definition-handlers";
import { makeHandlers } from "./handlers";
import { mountLiveUpdateRoute } from "./live-updates";
import { makeMetricSegmentHandlers } from "./metric-segment-handlers";
import type { MemberProfileResolver } from "./org-handlers";
import { controlPlaneRoute } from "./routes";
import type { SaltStore } from "@splitch/privacy";
import { mountUnavailableControlPlaneRoutes } from "./unavailable-handler";

/**
 * Control Plane API Worker HTTP surface.
 *
 * Every management route mounts through the @splitch/worker-runtime registrar so
 * the fixed guard chain (parse → resolve principal → rate-limit → scopes +
 * App/Env co-scope → idempotency → handler) is identical across routes and never
 * hand-rolled per endpoint (worker-runtime.md). This module wires the
 * control-plane-token resolver under its AuthKind and mounts the routes; the
 * guard does the rest.
 *
 * Authorization for App reads is the token's App co-scope binding: the guard
 * rejects a principal not bound to the path's App with FORBIDDEN BEFORE the
 * handler (and thus before any repository call). Org routes layer live D1
 * membership checks in their owning handler module (ADR-0022).
 */

export interface AppDeps {
  authResolver: AuthResolver;
  rateLimiter: RateLimiter;
  repo: Repository;
  credentialStore?: KVNamespace;
  credentialCacheWriter?: CredentialCacheWriterAccess;
  configStore?: ConfigStoreAccess;
  eventDefinitionStore?: KVNamespace;
  runSnapshotDelivery?: import("./run-snapshot").RunSnapshotDelivery;
  memberProfileResolver?: MemberProfileResolver;
  nowIso?: () => string;
  defaultHeaders?: Record<string, string>;
  observability?: RegistrarDeps["observability"];
  logger?: Pick<Console, "warn">;
  analysisResults?: AnalysisResultsReader;
  delegationBindings?: DelegationBindings;
  approvalArchiveStore?: import("./approval-archive").ApprovalArchiveStore;
  exposureStatusCleanup?: EnvironmentExposureStatusCleanup;
  holdoverWriteOutboxCleanup?: HoldoverWriteOutboxCleanup;
  saltStore?: SaltStore;
}

/** Build the registrar bound to this Worker's control-plane-token resolver. */
export function controlPlaneRegistrar(deps: AppDeps): Registrar {
  const registrarDeps: RegistrarDeps = {
    authResolvers: { "control-plane-token": deps.authResolver },
    rateLimiter: deps.rateLimiter,
    defaultHeaders: deps.defaultHeaders,
    observability: deps.observability,
  };
  return createRegistrar(registrarDeps);
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: route mounting stays explicit so no operation can be silently omitted
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const handlers = diagnosableHandlers(
    makeHandlers({
      repo: deps.repo,
      configStore: deps.configStore,
      memberProfileResolver: deps.memberProfileResolver,
      nowIso: deps.nowIso,
    }),
  );
  const credentialHandlers = makeCredentialHandlers({
    repo: deps.repo,
    credentialStore: deps.credentialStore,
    credentialCacheWriter: deps.credentialCacheWriter,
    nowIso: deps.nowIso,
  });
  const flagDefinitionHandlers = diagnosableHandlers(
    makeFlagDefinitionHandlers({
      repo: deps.repo,
      configStore: deps.configStore,
      logger: deps.logger,
      nowIso: deps.nowIso,
    }),
  );
  const metricSegmentHandlers = makeMetricSegmentHandlers({
    repo: deps.repo,
    configStore: deps.configStore,
    nowIso: deps.nowIso,
  });
  const experimentHandlers = diagnosableHandlers(
    makeExperimentHandlers({
      repo: deps.repo,
      configStore: deps.configStore,
      runSnapshotDelivery: deps.runSnapshotDelivery,
      nowIso: deps.nowIso,
    }),
  );
  const appEnvironmentHandlers = makeAppEnvironmentHandlers({
    repo: deps.repo,
    credentialStore: deps.credentialStore,
    credentialCacheWriter: deps.credentialCacheWriter,
    configStore: deps.configStore,
    ...appEnvironmentCleanupDeps(deps),
    nowIso: deps.nowIso,
  });
  const registrar = controlPlaneRegistrar(deps);
  const approvalHandlers = diagnosableHandlers(
    makeApprovalHandlers({
      repo: deps.repo,
      configStore: deps.configStore,
      nowIso: deps.nowIso,
      applyOther: makeOtherApprovalApplication({
        repo: deps.repo,
        configStore: deps.configStore,
        runSnapshotDelivery: deps.runSnapshotDelivery,
        nowIso: deps.nowIso,
      }),
      archiveStore: deps.approvalArchiveStore,
    }),
  );

  app.get("/.well-known/openapi.json", (c) => c.json(buildOpenApiDocument()));

  mountLiveUpdateRoute(app, {
    authResolver: deps.authResolver,
    rateLimiter: deps.rateLimiter,
    repo: deps.repo,
    configStore: deps.configStore,
    defaultHeaders: deps.defaultHeaders,
  });

  registrar.mount(app, controlPlaneRoute("apps_list"), appEnvironmentHandlers.listApps);
  registrar.mount(app, controlPlaneRoute("apps_create"), appEnvironmentHandlers.createApp);
  registrar.mount(app, controlPlaneRoute("apps_get"), appEnvironmentHandlers.getApp);
  mountAttentionRollupRoute(app, registrar, deps);
  registrar.mount(app, controlPlaneRoute("apps_update"), appEnvironmentHandlers.updateApp);
  registrar.mount(app, controlPlaneRoute("apps_delete"), appEnvironmentHandlers.deleteApp);
  mountAppMemberRoutes(app, registrar, deps);
  registrar.mount(
    app,
    controlPlaneRoute("environments_list"),
    appEnvironmentHandlers.listEnvironments,
  );
  registrar.mount(
    app,
    controlPlaneRoute("environments_create"),
    appEnvironmentHandlers.createEnvironment,
  );
  registrar.mount(
    app,
    controlPlaneRoute("environments_get"),
    appEnvironmentHandlers.getEnvironment,
  );
  registrar.mount(
    app,
    controlPlaneRoute("environments_update"),
    appEnvironmentHandlers.updateEnvironment,
  );
  registrar.mount(
    app,
    controlPlaneRoute("environments_delete"),
    appEnvironmentHandlers.deleteEnvironment,
  );
  registrar.mount(app, controlPlaneRoute("organizations_get"), handlers.getOrg);
  registrar.mount(app, controlPlaneRoute("organizations_list"), handlers.listOrganizations);
  registrar.mount(app, controlPlaneRoute("organizations_create"), handlers.createOrganization);
  registrar.mount(app, controlPlaneRoute("organizations_update"), handlers.updateOrg);
  registrar.mount(app, controlPlaneRoute("organization_members_list"), handlers.listMembers);
  registrar.mount(app, controlPlaneRoute("organization_members_add"), handlers.addMember);
  registrar.mount(app, controlPlaneRoute("organization_members_update"), handlers.updateMember);
  registrar.mount(app, controlPlaneRoute("organization_members_remove"), handlers.removeMember);
  registrar.mount(app, controlPlaneRoute("flags_list"), flagDefinitionHandlers.listFlags);
  registrar.mount(app, controlPlaneRoute("flags_create"), flagDefinitionHandlers.createFlag);
  registrar.mount(app, controlPlaneRoute("flags_get"), flagDefinitionHandlers.getFlag);
  registrar.mount(app, controlPlaneRoute("flags_update"), flagDefinitionHandlers.updateFlag);
  registrar.mount(app, controlPlaneRoute("flags_delete"), flagDefinitionHandlers.deleteFlag);
  registrar.mount(
    app,
    controlPlaneRoute("flag_variants_create"),
    flagDefinitionHandlers.createVariant,
  );
  registrar.mount(
    app,
    controlPlaneRoute("flag_variants_update"),
    flagDefinitionHandlers.updateVariant,
  );
  registrar.mount(
    app,
    controlPlaneRoute("flag_variants_delete"),
    flagDefinitionHandlers.deleteVariant,
  );
  registrar.mount(app, controlPlaneRoute("flag_config_get"), handlers.getFlagConfig);
  registrar.mount(app, controlPlaneRoute("flag_config_update"), handlers.updateFlagConfig);
  registrar.mount(
    app,
    controlPlaneRoute("flag_targeting_rules_replace"),
    handlers.replaceTargetingRules,
  );
  registrar.mount(app, controlPlaneRoute("flags_promote"), handlers.promoteFlagConfig);
  registrar.mount(app, controlPlaneRoute("approval_requests_list"), approvalHandlers.list);
  registrar.mount(app, controlPlaneRoute("approval_requests_get"), approvalHandlers.get);
  registrar.mount(
    app,
    controlPlaneRoute("approval_request_reviews_create"),
    approvalHandlers.review,
  );
  registrar.mount(app, controlPlaneRoute("segments_list"), metricSegmentHandlers.listSegments);
  registrar.mount(app, controlPlaneRoute("segments_create"), metricSegmentHandlers.createSegment);
  registrar.mount(app, controlPlaneRoute("segments_get"), metricSegmentHandlers.getSegment);
  registrar.mount(app, controlPlaneRoute("segments_update"), metricSegmentHandlers.updateSegment);
  registrar.mount(app, controlPlaneRoute("segments_delete"), metricSegmentHandlers.deleteSegment);
  mountExperimentRoutes(app, registrar, experimentHandlers);
  mountMetricRoutes(app, registrar, metricSegmentHandlers);
  registerEventDefinitionRoutes(app, registrar, {
    repo: deps.repo,
    eventDefinitionStore: deps.eventDefinitionStore,
    nowIso: deps.nowIso,
  });
  registrar.mount(app, controlPlaneRoute("client_key_get"), credentialHandlers.getClientKey);
  registrar.mount(app, controlPlaneRoute("client_key_update"), credentialHandlers.updateClientKey);
  registrar.mount(app, controlPlaneRoute("client_key_rotate"), credentialHandlers.rotateClientKey);
  registrar.mount(app, controlPlaneRoute("api_keys_list"), credentialHandlers.listApiKeys);
  registrar.mount(app, controlPlaneRoute("api_keys_create"), credentialHandlers.createApiKey);
  registrar.mount(app, controlPlaneRoute("api_keys_revoke"), credentialHandlers.revokeApiKey);
  const entityPrivacyReady =
    deps.saltStore !== undefined && deps.holdoverWriteOutboxCleanup !== undefined;
  mountUnavailableControlPlaneRoutes(app, registrar, deps.repo, {
    skipEntityPrivacyDelete: entityPrivacyReady,
  });
  if (entityPrivacyReady && deps.saltStore && deps.holdoverWriteOutboxCleanup) {
    registrar.mount(
      app,
      controlPlaneRoute("entity_privacy_delete"),
      makeEntityPrivacyDeleteHandler({
        repo: deps.repo,
        saltStore: deps.saltStore,
        holdoverWriteOutboxCleanup: deps.holdoverWriteOutboxCleanup,
        ...(deps.nowIso ? { nowIso: deps.nowIso } : {}),
      }),
    );
  }
  mountDelegatedRoutes(app, registrar, deps.delegationBindings ?? {}, deps.repo);

  return app;
}

function mountAppMemberRoutes(app: Hono, registrar: Registrar, deps: AppDeps): void {
  const handlers = makeAppMemberHandlers({
    repo: deps.repo,
    ...(deps.memberProfileResolver ? { memberProfileResolver: deps.memberProfileResolver } : {}),
    ...(deps.nowIso ? { nowIso: deps.nowIso } : {}),
  });
  registrar.mount(app, controlPlaneRoute("app_members_list"), handlers.listAppMembers);
  registrar.mount(app, controlPlaneRoute("app_members_add"), handlers.addAppMember);
  registrar.mount(app, controlPlaneRoute("app_members_update"), handlers.updateAppMember);
  registrar.mount(app, controlPlaneRoute("app_members_remove"), handlers.removeAppMember);
}

function mountAttentionRollupRoute(app: Hono, registrar: Registrar, deps: AppDeps): void {
  registrar.mount(
    app,
    controlPlaneRoute("app_attention_rollup_get"),
    makeAttentionRollupHandler({
      repo: deps.repo,
      analysisResults: deps.analysisResults ?? unavailableAnalysisResults,
    }),
  );
}

function mountExperimentRoutes(
  app: Hono,
  registrar: Registrar,
  handlers: ReturnType<typeof makeExperimentHandlers>,
): void {
  registrar.mount(app, controlPlaneRoute("experiments_list"), handlers.listExperiments);
  registrar.mount(app, controlPlaneRoute("experiments_create"), handlers.createExperiment);
  registrar.mount(app, controlPlaneRoute("experiments_get"), handlers.getExperiment);
  registrar.mount(app, controlPlaneRoute("experiments_update"), handlers.updateExperiment);
  registrar.mount(app, controlPlaneRoute("experiments_delete"), handlers.deleteExperiment);
  registrar.mount(app, controlPlaneRoute("experiments_start"), handlers.startExperiment);
  registrar.mount(app, controlPlaneRoute("runs_list"), handlers.listRuns);
  registrar.mount(app, controlPlaneRoute("runs_get"), handlers.getRun);
  registrar.mount(app, controlPlaneRoute("runs_end"), handlers.endRun);
}

function mountMetricRoutes(
  app: Hono,
  registrar: Registrar,
  handlers: ReturnType<typeof makeMetricSegmentHandlers>,
): void {
  registrar.mount(app, controlPlaneRoute("metrics_list"), handlers.listMetrics);
  registrar.mount(app, controlPlaneRoute("metrics_create"), handlers.createMetric);
  registrar.mount(app, controlPlaneRoute("metrics_get"), handlers.getMetric);
  registrar.mount(app, controlPlaneRoute("metrics_update"), handlers.updateMetric);
  registrar.mount(app, controlPlaneRoute("metrics_delete"), handlers.deleteMetric);
}
