import { appScope, createRepository, envScope, type Repository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { Miniflare } from "miniflare";
import {
  type ConfigStoreWriter,
  makeConfigStore,
} from "../../control-plane-api/src/config-store.js";
import { makeSnapshotRevisionCounter } from "../../control-plane-api/src/config-store-fixture-data.js";
import type { ConfigStoreAccess } from "../../control-plane-api/src/config-store-do.js";
import type { FixtureSigner } from "../../control-plane-api/src/fixture-signer.js";
import {
  appToken,
  createDefaultApp,
  type FlagDefinitionHarness,
  makeAppForRepo,
  makeFlagDefinitionHarness,
  NOW_ISO,
  orgToken,
  orgTokenFor,
} from "../../control-plane-api/src/flag-definition-test-harness.js";
import { makeLocalBindings } from "../../control-plane-api/src/test-fixtures.js";
import { createApp as createEvaluationApp } from "../../evaluation-api/src/app.js";
import { makeDataPlaneAuthResolver } from "../../evaluation-api/src/data-plane-auth.js";
import { RecordingAssignmentStore } from "../../evaluation-api/src/evaluate/evaluate-path-test-fixtures.js";
import { KvProvider } from "../../evaluation-api/src/provider/kv-provider.js";
import {
  RecordingEvaluationCommitSink,
  RecordingEvaluationUsageSink,
  RecordingExposureSink,
} from "../../evaluation-api/src/sdk-route-test-fixtures.js";

const CONTROL_PLANE_ORIGIN = "http://control-plane.local";
const EVALUATION_ORIGIN = "http://evaluation.local";
const FOREIGN_ORG_ID = "org_quickstart_foreign_live";
const allowLimiter: RateLimiter = () => ({ limited: false });

export interface QuickstartHarness {
  readonly controlPlaneApp: Hono;
  readonly evaluationApp: Hono;
  readonly repo: Repository;
  readonly configStore: ConfigStoreWriter;
  readonly signer: FixtureSigner;
  readonly flagHarness: FlagDefinitionHarness;
  readonly appId: string;
  readonly devEnvironmentId: string;
  readonly prodEnvironmentId: string;
  readonly orgId: string;
  readonly foreignOrgId: string;
  readonly foreignOrgAccessToken: string;
  readonly accessToken: string;
  readonly orgAccessToken: string;
  readonly routingFetch: typeof fetch;
  readonly evaluationUsageSink: RecordingEvaluationUsageSink;
  readonly exposureSink: RecordingExposureSink;
  readonly evaluationCommitSink: RecordingEvaluationCommitSink;
  invalidateFlagCache(appId?: string, environmentIds?: readonly string[]): void;
  dispose: () => Promise<void>;
}

export async function makeQuickstartHarness(): Promise<QuickstartHarness> {
  // This harness still runs on Node under its own Miniflare instance (it needs a
  // second KV namespace for Flag Configuration), so it passes the Node bindings
  // factory. Control-plane suites pass the Workers-pool one instead.
  const flagHarness = await makeFlagDefinitionHarness(makeLocalBindings);
  const configKvBinding = await createConfigKvNamespace();
  const configKv = configKvBinding.kv;
  const repo = createRepository(flagHarness.bindings.d1);
  await repo.identity.createOrganization({
    organization: {
      id: FOREIGN_ORG_ID,
      name: "Quickstart Foreign Organization",
      slug: "quickstart-foreign-live",
      plan: "free",
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
    ownerUserId: "user_quickstart_foreign_owner",
    createdAt: NOW_ISO,
  });
  await repo.identity.createApp({
    id: "app_quickstart_foreign_live",
    organizationId: FOREIGN_ORG_ID,
    name: "Quickstart Foreign Sentinel",
    key: "quickstart-foreign-sentinel",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  const signer = flagHarness.signer;
  const configStore = makeConfigStore({
    repo,
    kv: configKv,
    broadcaster: { broadcast() {} },
    nextSnapshotRevision: makeSnapshotRevisionCounter(),
    now: () => new Date(Date.parse(NOW_ISO)),
  });
  const configStoreAccess: ConfigStoreAccess = {
    writerFor() {
      return configStore;
    },
    liveUpdatesFor: () => ({
      connect: async () => new Response("test live updates unavailable", { status: 503 }),
    }),
  };

  flagHarness.app = makeAppForRepo(flagHarness, repo, configStoreAccess);

  const createdApp = await createDefaultApp(flagHarness);
  const appId = createdApp.app.id;
  const devEnvironmentId = createdApp.environments.find((env) => env.key === "dev")?.id ?? "";
  const prodEnvironmentId = createdApp.environments.find((env) => env.key === "prod")?.id ?? "";
  if (!devEnvironmentId || !prodEnvironmentId) {
    throw new Error(
      "quickstart harness: createDefaultApp did not provision dev and prod Environments",
    );
  }

  const accessToken = await appToken(flagHarness, appId);
  const orgAccessToken = await orgToken(flagHarness);
  // Intentionally claim foreign-Organization owner scope for the same signed
  // subject without inserting a foreign membership. This gets past the token
  // scope check and forces the DB-backed membership guard to reject stale or
  // forged authority. Mutating that guard to trust the claim makes the journey red.
  const foreignOrgAccessToken = await orgTokenFor(flagHarness, FOREIGN_ORG_ID);
  const controlPlaneApp = flagHarness.app;
  const evaluationUsageSink = new RecordingEvaluationUsageSink();
  const exposureSink = new RecordingExposureSink();
  const evaluationCommitSink = new RecordingEvaluationCommitSink(exposureSink, evaluationUsageSink);
  const provider = new KvProvider(configKv);
  const harnessSalt = new TextEncoder().encode(`quickstart-salt:${appId}`);
  const evaluationApp = createEvaluationApp({
    authResolver: () => ({ ok: false, reason: "UNAUTHORIZED" }),
    dataPlaneAuthResolver: makeDataPlaneAuthResolver(flagHarness.bindings.credentialKv),
    rateLimiter: allowLimiter,
    provider,
    assignmentStore: new RecordingAssignmentStore(),
    exposureAssembly: {
      saltStore: {
        currentKeyVersion: () => Promise.resolve("quickstart-v1"),
        saltFor: (requestedAppId: string) => {
          if (requestedAppId !== appId) {
            throw new Error(`quickstart harness: missing salt for ${requestedAppId}`);
          }
          return Promise.resolve(harnessSalt);
        },
      },
      sourceId: "quickstart-drift-test",
      newEventId: () => "evt-quickstart-1",
      now: () => new Date(Date.parse(NOW_ISO)),
    },
    evaluationCommitSink,
    evaluationUsageSink,
  });

  const routingFetch = createRoutingFetch(controlPlaneApp, evaluationApp);

  return {
    controlPlaneApp,
    evaluationApp,
    repo,
    configStore,
    signer,
    flagHarness,
    appId,
    devEnvironmentId,
    prodEnvironmentId,
    orgId: "org_flag_definition_crud",
    foreignOrgId: FOREIGN_ORG_ID,
    foreignOrgAccessToken,
    accessToken,
    orgAccessToken,
    routingFetch,
    evaluationUsageSink,
    exposureSink,
    evaluationCommitSink,
    invalidateFlagCache(
      targetAppId = appId,
      environmentIds = [devEnvironmentId, prodEnvironmentId],
    ) {
      for (const environmentId of environmentIds) {
        provider.invalidateEnvironment(targetAppId, environmentId);
      }
    },
    dispose: async () => {
      await flagHarness.bindings.dispose();
      await configKvBinding.dispose();
    },
  };
}

export async function findFlagByKey(
  harness: QuickstartHarness,
  flagKey: string,
): Promise<{ id: string; defaultVariantId: string; variants: Array<{ name: string }> }> {
  const scope = appScope(harness.appId);
  const rows = await harness.repo.flags.flags.findMany(scope);
  const flag = rows.find((row) => row.key === flagKey);
  if (!flag) {
    throw new Error(`quickstart harness: flag ${flagKey} was not created`);
  }
  const variants = await harness.repo.flags.listVariants(scope, flag.id);
  return {
    id: flag.id,
    defaultVariantId: flag.defaultVariantId,
    variants: variants.map((variant) => ({ name: variant.name })),
  };
}

export async function readConfigRollout(
  harness: QuickstartHarness,
  flagId: string,
  environmentId: string,
): Promise<{ percentage: number; salt: string } | null> {
  const config = await harness.repo.flags.getFlagConfig(
    envScope(harness.appId, environmentId),
    flagId,
  );
  return config?.rollout
    ? (JSON.parse(config.rollout) as { percentage: number; salt: string })
    : null;
}

export function storedHarnessCredential(harness: QuickstartHarness) {
  return {
    version: 1 as const,
    principal: {
      userId: "user_flag_definition_owner",
      email: "user_flag_definition_owner@splitch.test",
    },
    credential: {
      type: "device_flow" as const,
      refreshToken: "quickstart-refresh-token",
      accessToken: harness.accessToken,
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      selectedAppId: harness.appId,
    },
  };
}

async function createConfigKvNamespace(): Promise<{
  kv: KVNamespace;
  dispose: () => Promise<void>;
}> {
  const mf = new Miniflare({
    modules: true,
    script: "export default {};",
    kvNamespaces: { CONFIG_STORE: "config" },
  });
  const kv = (await mf.getKVNamespace("CONFIG_STORE")) as unknown as KVNamespace;
  return { kv, dispose: () => mf.dispose() };
}

function createRoutingFetch(controlPlaneApp: Hono, evaluationApp: Hono): typeof fetch {
  return async (input, init) => {
    const url = toUrl(input);
    const requestInit = await toRequestInit(input, init);
    if (url.origin === CONTROL_PLANE_ORIGIN) {
      return controlPlaneApp.request(toRequestPath(url), requestInit);
    }
    if (url.origin === EVALUATION_ORIGIN) {
      return evaluationApp.request(toRequestPath(url), requestInit);
    }
    throw new Error(`quickstart harness: no handler for ${url.origin}${url.pathname}`);
  };
}

function toUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

function toRequestPath(url: URL): string {
  return `${url.pathname}${url.search}`;
}

async function toRequestInit(input: RequestInfo | URL, init?: RequestInit): Promise<RequestInit> {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const body = await readRequestBody(method, input, init);
  return body === undefined ? { method, headers } : { method, headers, body };
}

async function readRequestBody(
  method: string,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<BodyInit | undefined> {
  if (method === "GET" || method === "HEAD") {
    return undefined;
  }
  const body = init?.body ?? (await readRequestText(input));
  return body === "" ? undefined : body;
}

async function readRequestText(input: RequestInfo | URL): Promise<string | undefined> {
  if (!(input instanceof Request) || input.bodyUsed) {
    return undefined;
  }
  return input.text();
}

export const quickstartOrigins = {
  controlPlaneBaseUrl: CONTROL_PLANE_ORIGIN,
  evaluationBaseUrl: EVALUATION_ORIGIN,
} as const;
