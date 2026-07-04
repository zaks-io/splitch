import {
  apiKeyCacheKey,
  clientKeyCacheKey,
  CredentialCacheKVSchema,
  experimentConfigKey,
  flagConfigKey,
  runConfigKey,
  type ExperimentConfigKV,
  type FlagConfigKV,
  type RunConfigKV,
} from "@splitch/contracts";
import type { AuthResolver, RateLimiter } from "@splitch/worker-runtime";
import { StaticSaltStore } from "./assignment/assignment-store-test-fixtures.js";
import { createApp } from "./app.js";
import { makeDataPlaneAuthResolver, sha256Hex } from "./data-plane-auth.js";
import type { AssembledExposure } from "./evaluate/exposure-assembly.js";
import {
  APP_ID,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  FLAG_KEY,
  RecordingAssignmentStore,
  baseInput,
  targetingRule,
} from "./evaluate/evaluate-path-test-fixtures.js";
import { FakeKv } from "./provider/fake-kv.js";
import { experimentConfigKV, flagConfigKV, runConfigKV } from "./provider/fixtures.js";
import { KvProvider } from "./provider/kv-provider.js";

export { APP_ID, ENVIRONMENT_ID, EXPERIMENT_ID, FLAG_KEY, sha256Hex };

export const CLIENT_KEY = "pk_verify_client";
export const LOCKED_CLIENT_KEY = "pk_verify_locked";
export const API_KEY = "sk_verify_api";
export const UNSCOPED_API_KEY = "sk_verify_unscoped";
export const REVOKED_CLIENT_KEY = "pk_verify_revoked";

const allowLimiter: RateLimiter = () => ({ limited: false });
const controlPlaneAuthResolver: AuthResolver = () => ({ ok: false, reason: "UNAUTHORIZED" });

interface SdkRouteHarnessOptions {
  readonly liveRun?: boolean;
  readonly experimentOverrides?: Partial<ExperimentConfigKV>;
  readonly exposureSink?: RecordingExposureSink;
  readonly flagOverrides?: Partial<FlagConfigKV>;
  readonly holdovers?: Map<string, { runId: string; variant: string }>;
  readonly runOverrides?: Partial<RunConfigKV>;
}

function seededConfigKv(options: SdkRouteHarnessOptions = {}): FakeKv {
  const kv = new FakeKv()
    .put(
      flagConfigKey(APP_ID, ENVIRONMENT_ID, FLAG_KEY),
      flagConfigKV({
        experimentId: EXPERIMENT_ID,
        targetingRules: [targetingRule({ id: "rule-enterprise" })],
        ...options.flagOverrides,
      }),
    )
    .put(
      experimentConfigKey(APP_ID, ENVIRONMENT_ID, EXPERIMENT_ID),
      options.liveRun
        ? experimentConfigKV(options.experimentOverrides)
        : experimentConfigKV({ liveRunId: null, status: "draft", ...options.experimentOverrides }),
    );

  return options.liveRun
    ? kv.put(runConfigKey(APP_ID, ENVIRONMENT_ID, "run-42"), runConfigKV(options.runOverrides))
    : kv;
}

async function seededCredentialKv(): Promise<FakeKv> {
  return new FakeKv()
    .put(
      clientKeyCacheKey(await sha256Hex(CLIENT_KEY)),
      CredentialCacheKVSchema.parse({
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        kind: "client_key",
        scopes: ["data-plane:evaluate"],
        originAllowlist: null,
        rateLimitRps: null,
        revoked: false,
        cachedAt: "2026-07-02T00:00:00.000Z",
      }),
    )
    .put(
      clientKeyCacheKey(await sha256Hex(LOCKED_CLIENT_KEY)),
      CredentialCacheKVSchema.parse({
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        kind: "client_key",
        scopes: ["data-plane:evaluate"],
        originAllowlist: ["https://app.example.test"],
        rateLimitRps: null,
        revoked: false,
        cachedAt: "2026-07-02T00:00:00.000Z",
      }),
    )
    .put(
      apiKeyCacheKey(await sha256Hex(API_KEY)),
      CredentialCacheKVSchema.parse({
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        kind: "api_key",
        scopes: ["data-plane:evaluate"],
        revoked: false,
        cachedAt: "2026-07-02T00:00:00.000Z",
      }),
    )
    .put(
      apiKeyCacheKey(await sha256Hex(UNSCOPED_API_KEY)),
      CredentialCacheKVSchema.parse({
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        kind: "api_key",
        scopes: [],
        revoked: false,
        cachedAt: "2026-07-02T00:00:00.000Z",
      }),
    )
    .put(
      clientKeyCacheKey(await sha256Hex(REVOKED_CLIENT_KEY)),
      CredentialCacheKVSchema.parse({
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        kind: "client_key",
        scopes: ["data-plane:evaluate"],
        revoked: true,
        cachedAt: "2026-07-02T00:00:00.000Z",
      }),
    );
}

export async function makeSdkRouteHarness(options: SdkRouteHarnessOptions = {}) {
  const configKv = seededConfigKv(options);
  const credentialKv = await seededCredentialKv();
  const assignmentStore = new RecordingAssignmentStore({ holdovers: options.holdovers });
  const exposureSink = options.exposureSink ?? new RecordingExposureSink();
  const app = createApp({
    authResolver: controlPlaneAuthResolver,
    dataPlaneAuthResolver: makeDataPlaneAuthResolver(credentialKv),
    rateLimiter: allowLimiter,
    provider: new KvProvider(configKv),
    assignmentStore,
    exposureAssembly: {
      saltStore: new StaticSaltStore(),
      sourceId: "pop-route-test",
      newEventId: () => "evt-route-1",
      now: () => new Date("2026-07-03T00:00:00.000Z"),
    },
    exposureSink,
  });
  return { app, assignmentStore, configKv, credentialKv, exposureSink };
}

export function sdkRouteInit(
  credential?: string,
  extraHeaders: Record<string, string> = {},
  bodyOverrides: Record<string, unknown> = {},
): RequestInit {
  return {
    method: "POST",
    headers: {
      ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify({
      flagKey: FLAG_KEY,
      targetingKey: baseInput().evaluationContext.targetingKey,
      idType: baseInput().evaluationContext.idType,
      attributes: baseInput().evaluationContext.attributes,
      ...bodyOverrides,
    }),
  };
}

export class RecordingExposureSink {
  readonly writes: AssembledExposure[] = [];

  async write(exposure: AssembledExposure): Promise<void> {
    this.writes.push(exposure);
  }
}
