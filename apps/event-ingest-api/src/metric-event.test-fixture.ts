import {
  apiKeyCacheKey,
  CURRENT_KV_SCHEMA_VERSION,
  clientKeyCacheKey,
  eventDefinitionConfigKey,
  getRoute,
} from "@splitch/contracts";
import { delegatedRequest } from "@splitch/worker-runtime";
import { EvaluationEntrypoint } from "./index";
import { TestExecutionContext } from "./test-execution-context";
import { type AdmissionCharge, type AdmissionOption, admissionBinding } from "./test-fixtures";
import type { Env } from "./types";

export const METRIC_APP_ID = "app_shop";
export const METRIC_ENVIRONMENT_ID = "env_prod";
const METRIC_ORGANIZATION_ID = "org_1";
export const METRIC_CLIENT_KEY = "pk_metric_events";
export const METRIC_EVENT_NAME = "signed_up";

interface Claim {
  fingerprint: string;
  eventDefinitionId: string;
  eventDefinitionVersionId: string;
  activatedRuns?: number;
  activationRows?: readonly Record<string, unknown>[];
}

export interface MetricEventFixture {
  readonly env: Env;
  readonly config: Map<string, string>;
  readonly assignments: Map<string, string>;
  readonly claims: Map<string, Claim>;
  readonly admissionCharges: AdmissionCharge[];
  readonly hash: string;
  readonly credentialKind: "api_key" | "client_key";
}

/** The credential, Event Definition config and outbox the live ingest path reads. */
export async function makeMetricEventFixture(
  base: Partial<Env> = {},
  credentialKind: "api_key" | "client_key" = "client_key",
  options: {
    admission?: AdmissionOption;
    credential?: { revoked?: boolean; scopes?: string[]; rateLimitRps?: number | null };
    omitCredentialStore?: boolean;
  } = {},
): Promise<MetricEventFixture> {
  const hash = await sha256Hex(METRIC_CLIENT_KEY);
  const key = credentialKind === "client_key" ? clientKeyCacheKey(hash) : apiKeyCacheKey(hash);
  const credential = new Map<string, string>([
    [key, credentialRecord(credentialKind, options.credential)],
  ]);
  const config = new Map([
    [eventDefinitionConfigKey(METRIC_APP_ID, METRIC_EVENT_NAME), hotConfig("edv_1", 1)],
  ]);
  const claims = new Map<string, Claim>();
  const assignments = new Map<string, string>();
  const admissionCharges: AdmissionCharge[] = [];
  const env = {
    SPLITCH_PLATFORM_TARGET: "local",
    ...base,
    ...(options.omitCredentialStore ? {} : { CREDENTIAL_STORE: kv(credential) }),
    CONFIG_STORE: mergedConfigStore(base.CONFIG_STORE, config),
    CONFIG_STORE_WRITER: base.CONFIG_STORE_WRITER ?? appIdentityWriter(config),
    ASSIGNMENTS_KV: base.ASSIGNMENTS_KV ?? kv(assignments),
    METRIC_EVENT_OUTBOX: outboxStub(claims),
    ...admissionBinding(options.admission, admissionCharges),
  } as unknown as Env;
  return { env, config, assignments, claims, admissionCharges, hash, credentialKind };
}

function appIdentityWriter(values: Map<string, string>): NonNullable<Env["CONFIG_STORE_WRITER"]> {
  return {
    getByName: () => ({
      async readAppIdentity(appId: string) {
        return values.get(`app:${appId}:entity-identity`) ?? null;
      },
      async putAppIdentityIfAbsent(appId: string, value: string) {
        const key = `app:${appId}:entity-identity`;
        const winner = values.get(key);
        if (winner !== undefined) return winner;
        values.set(key, value);
        return value;
      },
    }),
  };
}

/** The live path: what the Evaluation Worker hands over the EVENT_INGEST binding. */
export async function sendMetricEvent(
  fixture: Pick<MetricEventFixture, "credentialKind" | "env" | "hash">,
  body: unknown,
  options: { actorId?: string } = {},
): Promise<Response> {
  return new EvaluationEntrypoint(new TestExecutionContext(), fixture.env).fetch(
    delegatedRequest(
      metricEventRoute(),
      {
        operation: "sdk_track",
        actorId: options.actorId ?? `${fixture.credentialKind}:${fixture.hash}`,
        orgId: METRIC_ORGANIZATION_ID,
        appId: METRIC_APP_ID,
        environmentId: METRIC_ENVIRONMENT_ID,
      },
      { body },
    ),
  );
}

export async function sendActivation(
  fixture: Pick<MetricEventFixture, "credentialKind" | "env" | "hash">,
  body: unknown,
): Promise<Response> {
  const route = getRoute("sdk_activate");
  if (!route) throw new Error("sdk_activate route is missing");
  return new EvaluationEntrypoint(new TestExecutionContext(), fixture.env).fetch(
    delegatedRequest(
      route,
      {
        operation: "sdk_activate",
        actorId: `${fixture.credentialKind}:${fixture.hash}`,
        orgId: METRIC_ORGANIZATION_ID,
        appId: METRIC_APP_ID,
        environmentId: METRIC_ENVIRONMENT_ID,
      },
      { body },
    ),
  );
}

function metricEventRoute() {
  const route = getRoute("sdk_track");
  if (!route) throw new Error("sdk_track route is missing");
  return route;
}

export function metricEventBody(patch: Record<string, unknown> = {}) {
  return {
    eventName: METRIC_EVENT_NAME,
    targetingKey: "entity-7",
    idType: "user",
    eventId: "123e4567-e89b-42d3-a456-426614174000",
    fields: { converted: true },
    dimensions: { plan: "pro" },
    ...patch,
  };
}

export function hotConfig(
  versionId: string,
  version: number,
  versionPatch: Record<string, unknown> = {},
  eventDefinitionPatch: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: CURRENT_KV_SCHEMA_VERSION,
    data: {
      eventDefinition: {
        id: "ed_signed_up",
        appId: METRIC_APP_ID,
        name: METRIC_EVENT_NAME,
        family: "metric",
        displayName: "Signed up",
        state: "published",
        currentPublishedVersionId: versionId,
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:00:00.000Z",
        ...eventDefinitionPatch,
      },
      version: {
        id: versionId,
        eventDefinitionId: "ed_signed_up",
        version,
        schemaHash: `sha256:${"a".repeat(64)}`,
        entityType: "user",
        fields: [{ name: "converted", type: "boolean", required: true }],
        dimensions: [
          { name: "plan", type: "string", required: true, allowedValues: ["pro", "free"] },
        ],
        publishedAt: "2026-08-07T00:00:00.000Z",
        ...versionPatch,
      },
    },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function credentialRecord(
  kind: "api_key" | "client_key",
  patch: { revoked?: boolean; scopes?: string[]; rateLimitRps?: number | null } = {},
): string {
  return JSON.stringify({
    schemaVersion: CURRENT_KV_SCHEMA_VERSION,
    data: {
      credentialSchemaVersion: 2,
      organizationId: METRIC_ORGANIZATION_ID,
      kind,
      appId: METRIC_APP_ID,
      environmentId: METRIC_ENVIRONMENT_ID,
      scopes: patch.scopes ?? ["data-plane:evaluate", "data-plane:write"],
      ...(kind === "client_key"
        ? { originAllowlist: null, rateLimitRps: patch.rateLimitRps ?? null }
        : {}),
      revoked: patch.revoked ?? false,
      cachedAt: "2026-08-07T00:00:00.000Z",
    },
  });
}

/** Keeps any Exposure/Evaluation config the caller already seeded readable. */
function mergedConfigStore(base: KVNamespace | undefined, values: Map<string, string>) {
  return {
    async get(key: string) {
      return values.get(key) ?? (base ? ((await base.get(key)) as string | null) : null);
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
  } as KVNamespace;
}

function outboxStub(claims: Map<string, Claim>) {
  return {
    idFromName(name: string) {
      return name as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      return {
        fetch(input: RequestInfo | URL, init?: RequestInit) {
          return requestMethod(input, init) === "GET"
            ? lookupClaim(claims, String(id))
            : claimOrConflict(claims, String(id), JSON.parse(String(init?.body)) as Claim);
        },
      };
    },
  };
}

function lookupClaim(claims: Map<string, Claim>, key: string): Promise<Response> {
  const existing = claims.get(key);
  return Promise.resolve(
    existing ? Response.json(existing) : new Response("not found", { status: 404 }),
  );
}

function claimOrConflict(claims: Map<string, Claim>, key: string, body: Claim): Promise<Response> {
  const existing = claims.get(key);
  if (existing && existing.fingerprint !== body.fingerprint) {
    return Promise.resolve(
      Response.json({
        outcome: "conflict",
        activatedRuns: existing.activatedRuns ?? 0,
        ...existing,
      }),
    );
  }
  if (existing) {
    return Promise.resolve(
      Response.json({
        outcome: "duplicate",
        activatedRuns: existing.activatedRuns ?? 0,
        ...existing,
      }),
    );
  }
  claims.set(key, body);
  return Promise.resolve(Response.json({ outcome: "accepted", ...body }));
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method !== undefined) return init.method;
  if (input instanceof Request) return input.method;
  return "GET";
}

function kv(values: Map<string, string>) {
  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
  } as KVNamespace;
}
