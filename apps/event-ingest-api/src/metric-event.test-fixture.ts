import {
  CURRENT_KV_SCHEMA_VERSION,
  clientKeyCacheKey,
  eventDefinitionConfigKey,
  getRoute,
} from "@splitch/contracts";
import { delegatedRequest } from "@splitch/worker-runtime";
import { EvaluationEntrypoint } from "./index";
import { TestExecutionContext } from "./test-fixtures";
import type { Env } from "./types";

export const METRIC_APP_ID = "app_shop";
const METRIC_ENVIRONMENT_ID = "env_prod";
const METRIC_ORGANIZATION_ID = "org_1";
export const METRIC_CLIENT_KEY = "pk_metric_events";
export const METRIC_EVENT_NAME = "signed_up";

interface Claim {
  fingerprint: string;
  eventDefinitionId: string;
  eventDefinitionVersionId: string;
}

export interface MetricEventFixture {
  readonly env: Env;
  readonly config: Map<string, string>;
  readonly claims: Map<string, Claim>;
  readonly hash: string;
}

/** The Client Key, Event Definition config and outbox the live ingest path reads. */
export async function makeMetricEventFixture(base: Partial<Env> = {}): Promise<MetricEventFixture> {
  const hash = await sha256Hex(METRIC_CLIENT_KEY);
  const credential = new Map<string, string>([[clientKeyCacheKey(hash), clientKeyRecord()]]);
  const config = new Map([
    [eventDefinitionConfigKey(METRIC_APP_ID, METRIC_EVENT_NAME), hotConfig("edv_1", 1)],
  ]);
  const claims = new Map<string, Claim>();
  const env = {
    SPLITCH_PLATFORM_TARGET: "local",
    ...base,
    CREDENTIAL_STORE: kv(credential),
    CONFIG_STORE: mergedConfigStore(base.CONFIG_STORE, config),
    METRIC_EVENT_OUTBOX: outboxStub(claims),
  } as unknown as Env;
  return { env, config, claims, hash };
}

/** The live path: what the Evaluation Worker hands over the EVENT_INGEST binding. */
export async function sendMetricEvent(
  fixture: Pick<MetricEventFixture, "env" | "hash">,
  body: unknown,
): Promise<Response> {
  return new EvaluationEntrypoint(new TestExecutionContext(), fixture.env).fetch(
    delegatedRequest(
      metricEventRoute(),
      {
        operation: "sdk_track",
        actorId: `client_key:${fixture.hash}`,
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

export function hotConfig(versionId: string, version: number): string {
  return JSON.stringify({
    schemaVersion: CURRENT_KV_SCHEMA_VERSION,
    data: {
      eventDefinition: {
        id: "ed_signed_up",
        appId: METRIC_APP_ID,
        name: METRIC_EVENT_NAME,
        family: "metric",
        displayName: "Signed up",
        currentPublishedVersionId: versionId,
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:00:00.000Z",
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
      },
    },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clientKeyRecord(): string {
  return JSON.stringify({
    schemaVersion: CURRENT_KV_SCHEMA_VERSION,
    data: {
      credentialSchemaVersion: 2,
      organizationId: METRIC_ORGANIZATION_ID,
      kind: "client_key",
      appId: METRIC_APP_ID,
      environmentId: METRIC_ENVIRONMENT_ID,
      scopes: ["data-plane:evaluate", "data-plane:write"],
      originAllowlist: null,
      rateLimitRps: null,
      revoked: false,
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
  } as KVNamespace;
}

function outboxStub(claims: Map<string, Claim>) {
  return {
    idFromName(name: string) {
      return name as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      return {
        async fetch(_input: RequestInfo | URL, init?: RequestInit) {
          const body = JSON.parse(String(init?.body)) as Claim;
          const key = String(id);
          const existing = claims.get(key);
          if (existing && existing.fingerprint !== body.fingerprint) {
            return Response.json({ outcome: "conflict", ...existing });
          }
          if (existing) return Response.json({ outcome: "duplicate", ...existing });
          claims.set(key, body);
          return Response.json({ outcome: "accepted", ...body });
        },
      };
    },
  };
}

function kv(values: Map<string, string>) {
  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
  } as KVNamespace;
}
