import {
  apiKeyCacheKey,
  CredentialCacheKVSchema,
  CredentialCacheKVSchemaV1,
  clientKeyCacheKey,
  type ExperimentConfigKV,
  experimentConfigKey,
  type FlagConfigKV,
  flagConfigKey,
  kvEnvelope,
  type RunConfigKV,
  runConfigKey,
} from "@splitch/contracts";
import type { AuthResolver, RateLimiter } from "@splitch/worker-runtime";
import { createApp, type EvaluationDoor } from "./app";
import { StaticSaltStore } from "./assignment/assignment-store-test-fixtures";
import { makeDataPlaneAuthResolver, sha256Hex } from "./data-plane-auth";
import {
  APP_ID,
  baseInput,
  ENVIRONMENT_ID,
  EXPERIMENT_ID,
  FLAG_KEY,
  RecordingAssignmentStore,
  RecordingLogger,
  targetingRule,
} from "./evaluate/evaluate-path-test-fixtures";
import type { AssembledExposure } from "./evaluate/exposure-assembly";
import type { EvaluationCommitEvent, EvaluationCommitSink } from "./evaluation-commit-sink";
import type { EvaluationUsageEvent, EvaluationUsageSink } from "./evaluation-usage-sink";
import {
  MemoryExposureRedemptionClaimStore,
  RecordingExposureIngestSink,
} from "./exposure-redemption";
import { FakeKv } from "./provider/fake-kv";
import { experimentConfigKV, flagConfigKV, runConfigKV } from "./provider/fixtures";
import { KvProvider } from "./provider/kv-provider";

export { APP_ID, ENVIRONMENT_ID, EXPERIMENT_ID, FLAG_KEY, sha256Hex };

export const CLIENT_KEY = "pk_verify_client";
export const LOCKED_CLIENT_KEY = "pk_verify_locked";
export const API_KEY = "sk_verify_api";
export const UNSCOPED_API_KEY = "sk_verify_unscoped";
export const REVOKED_CLIENT_KEY = "pk_verify_revoked";

const allowLimiter: RateLimiter = () => ({ limited: false });
const controlPlaneAuthResolver: AuthResolver = () => ({ ok: false, reason: "UNAUTHORIZED" });
const ORGANIZATION_ID = "org_verify";

interface SdkRouteHarnessOptions {
  /** Defaults to the public edge, which is where every SDK route is addressed. */
  readonly door?: EvaluationDoor;
  readonly liveRun?: boolean;
  readonly experimentOverrides?: Partial<ExperimentConfigKV>;
  readonly evaluationCommitSink?: EvaluationCommitSink;
  readonly evaluationUsageSink?: RecordingEvaluationUsageSink;
  readonly exposureIngestSink?: RecordingExposureIngestSink;
  readonly exposureRedemptionClaims?: MemoryExposureRedemptionClaimStore;
  readonly flagOverrides?: Partial<FlagConfigKV>;
  readonly holdovers?: Map<string, { runId: string; variant: string }>;
  readonly runOverrides?: Partial<RunConfigKV>;
  readonly legacyClientKey?: boolean;
  /** Override Exposure Ticket issued_at for ETag-stability tests. */
  readonly ticketNow?: () => Date;
  readonly previousTicketKey?: string;
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

async function seededCredentialKv(options: SdkRouteHarnessOptions = {}): Promise<FakeKv> {
  const credentialKv = new FakeKv()
    .put(
      clientKeyCacheKey(await sha256Hex(CLIENT_KEY)),
      CredentialCacheKVSchema.parse({
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        credentialSchemaVersion: 2,
        organizationId: ORGANIZATION_ID,
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
        credentialSchemaVersion: 2,
        organizationId: ORGANIZATION_ID,
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
        credentialSchemaVersion: 2,
        organizationId: ORGANIZATION_ID,
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
        credentialSchemaVersion: 2,
        organizationId: ORGANIZATION_ID,
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
        credentialSchemaVersion: 2,
        organizationId: ORGANIZATION_ID,
        kind: "client_key",
        scopes: ["data-plane:evaluate"],
        revoked: true,
        cachedAt: "2026-07-02T00:00:00.000Z",
      }),
    );

  if (options.legacyClientKey) {
    credentialKv.putRaw(
      clientKeyCacheKey(await sha256Hex(CLIENT_KEY)),
      JSON.stringify(
        kvEnvelope(CredentialCacheKVSchemaV1).parse({
          schemaVersion: 1,
          data: {
            appId: APP_ID,
            environmentId: ENVIRONMENT_ID,
            kind: "client_key",
            scopes: ["data-plane:evaluate"],
            originAllowlist: null,
            rateLimitRps: null,
            revoked: false,
            cachedAt: "2026-07-02T00:00:00.000Z",
          },
        }),
      ),
    );
  }

  return credentialKv;
}

export async function makeSdkRouteHarness(options: SdkRouteHarnessOptions = {}) {
  const configKv = seededConfigKv(options);
  const credentialKv = await seededCredentialKv(options);
  const assignmentStore = new RecordingAssignmentStore({ holdovers: options.holdovers });
  const exposureSink = new RecordingExposureSink();
  const evaluationUsageSink = options.evaluationUsageSink ?? new RecordingEvaluationUsageSink();
  const evaluationCommitSink =
    options.evaluationCommitSink ??
    new RecordingEvaluationCommitSink(exposureSink, evaluationUsageSink);
  const exposureIngestSink =
    options.exposureIngestSink ?? new RecordingExposureIngestSink(exposureSink);
  const exposureRedemptionClaims =
    options.exposureRedemptionClaims ?? new MemoryExposureRedemptionClaimStore();
  const logger = new RecordingLogger();
  const app = createApp({
    logger,
    door: options.door ?? "public",
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
    exposureTicket: {
      saltStore: new StaticSaltStore(),
      ticketKey: "splitch-test-exposure-ticket-key-32chars",
      previousTicketKey: options.previousTicketKey,
      now: options.ticketNow ?? (() => new Date("2026-07-03T00:00:00.000Z")),
    },
    exposureIngestSink,
    exposureRedemptionClaims,
    evaluationCommitSink,
    evaluationUsageSink,
  });
  return {
    app,
    assignmentStore,
    configKv,
    credentialKv,
    exposureSink,
    exposureIngestSink,
    exposureRedemptionClaims,
    evaluationUsageSink,
    logger,
  };
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
      "idempotency-key": "test-logical-evaluation",
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

/** evaluate-all request body: DataPlaneEvaluateRequest minus flagKey. */
export function evaluateAllRouteInit(
  credential?: string,
  extraHeaders: Record<string, string> = {},
  bodyOverrides: Record<string, unknown> = {},
): RequestInit {
  const { flagKey: _flagKey, ...body } = JSON.parse(
    String(sdkRouteInit(credential, extraHeaders, bodyOverrides).body),
  ) as Record<string, unknown>;
  return {
    method: "POST",
    headers: {
      ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
      "content-type": "application/json",
      "idempotency-key": "test-logical-evaluate-all",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

export class RecordingExposureSink {
  readonly writes: AssembledExposure[] = [];

  async write(exposure: AssembledExposure): Promise<void> {
    this.writes.push(exposure);
  }
}

export class RecordingEvaluationUsageSink implements EvaluationUsageSink {
  readonly writes: EvaluationUsageEvent[] = [];

  async write(event: EvaluationUsageEvent): Promise<void> {
    this.writes.push(event);
  }
}

export class RecordingEvaluationCommitSink implements EvaluationCommitSink {
  readonly writes: EvaluationCommitEvent[] = [];

  constructor(
    private readonly exposureSink: RecordingExposureSink,
    private readonly evaluationUsageSink: RecordingEvaluationUsageSink,
  ) {}

  async write(event: EvaluationCommitEvent): Promise<void> {
    this.writes.push(event);
    for (const exposure of event.exposures) await this.exposureSink.write(exposure);
    await this.evaluationUsageSink.write(event.usage);
  }
}
