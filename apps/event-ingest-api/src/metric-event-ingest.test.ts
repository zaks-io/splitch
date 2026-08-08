import {
  CURRENT_KV_SCHEMA_VERSION,
  clientKeyCacheKey,
  eventDefinitionConfigKey,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { handleMetricEvent } from "./metric-event-ingest";
import type { Env } from "./types";

const appId = "app_shop";
const environmentId = "env_prod";
const eventId = "123e4567-e89b-42d3-a456-426614174000";

describe("Metric Event ingest", () => {
  it("accepts once, returns the original Version on retry, and rejects conflicting reuse", async () => {
    const fixture = await makeFixture();
    const first = await send(fixture.env, requestBody());
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({
      duplicate: false,
      eventDefinitionVersionId: "edv_1",
    });

    fixture.config.set(eventDefinitionConfigKey(appId, "signed_up"), hotConfig("edv_2", 2));
    const retry = await send(fixture.env, requestBody());
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({
      duplicate: true,
      eventDefinitionVersionId: "edv_1",
    });

    const conflict = await send(fixture.env, requestBody({ fields: { converted: false } }));
    expect(conflict.status).toBe(409);
    expect(await responseCode(conflict)).toBe("EVENT_ID_CONFLICT");
    expect(fixture.claims.size).toBe(1);
  });

  it("rejects unknown fields before creating a durable claim", async () => {
    const fixture = await makeFixture();
    const response = await send(
      fixture.env,
      requestBody({ fields: { converted: true, profile: "forbidden" } }),
    );
    expect(response.status).toBe(400);
    expect(await responseCode(response)).toBe("EVENT_SCHEMA_MISMATCH");
    expect(fixture.claims.size).toBe(0);
  });

  it("rejects a disallowed origin before reading Event Definition config", async () => {
    const fixture = await makeFixture({ originAllowlist: ["https://allowed.example"] });
    const response = await send(fixture.env, requestBody(), "https://denied.example");
    expect(response.status).toBe(403);
    expect(await responseCode(response)).toBe("ORIGIN_NOT_ALLOWED");
    expect(fixture.configReads()).toBe(0);
    expect(fixture.claims.size).toBe(0);
  });
});

async function makeFixture(options: { originAllowlist?: string[] | null } = {}) {
  const material = "pk_metric_events";
  const hash = await sha256(material);
  const credential = new Map<string, string>([
    [
      clientKeyCacheKey(hash),
      JSON.stringify({
        schemaVersion: CURRENT_KV_SCHEMA_VERSION,
        data: {
          credentialSchemaVersion: 2,
          organizationId: "org_1",
          kind: "client_key",
          appId,
          environmentId,
          scopes: ["data-plane:evaluate", "data-plane:write"],
          originAllowlist: options.originAllowlist ?? null,
          rateLimitRps: null,
          revoked: false,
          cachedAt: new Date().toISOString(),
        },
      }),
    ],
  ]);
  const config = new Map([[eventDefinitionConfigKey(appId, "signed_up"), hotConfig("edv_1", 1)]]);
  let reads = 0;
  const claims = new Map<
    string,
    { fingerprint: string; eventDefinitionId: string; eventDefinitionVersionId: string }
  >();
  const env = {
    SPLITCH_PLATFORM_TARGET: "local",
    CREDENTIAL_STORE: kv(credential),
    CONFIG_STORE: {
      ...kv(config),
      async get(key: string) {
        reads += 1;
        return config.get(key) ?? null;
      },
    },
    METRIC_EVENT_OUTBOX: {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get(id: DurableObjectId) {
        return {
          async fetch(_input: RequestInfo | URL, init?: RequestInit) {
            const body = JSON.parse(String(init?.body)) as {
              fingerprint: string;
              eventDefinitionId: string;
              eventDefinitionVersionId: string;
            };
            const key = String(id);
            const existing = claims.get(key);
            if (existing && existing.fingerprint !== body.fingerprint)
              return Response.json({ outcome: "conflict", ...existing });
            if (existing) return Response.json({ outcome: "duplicate", ...existing });
            claims.set(key, body);
            return Response.json({ outcome: "accepted", ...body });
          },
        };
      },
    },
  } as unknown as Env;
  return { env, config, claims, configReads: () => reads, material };
}

function requestBody(patch: Record<string, unknown> = {}) {
  return {
    eventName: "signed_up",
    targetingKey: "entity-7",
    idType: "user",
    eventId,
    fields: { converted: true },
    dimensions: { plan: "pro" },
    ...patch,
  };
}

async function send(env: Env, body: unknown, origin = "https://allowed.example") {
  return handleMetricEvent(
    new Request("https://ingest.test/api/sdk/events", {
      method: "POST",
      headers: {
        authorization: "Bearer pk_metric_events",
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function responseCode(response: Response): Promise<unknown> {
  return ((await response.json()) as { code?: unknown }).code;
}

function hotConfig(versionId: string, version: number): string {
  return JSON.stringify({
    schemaVersion: CURRENT_KV_SCHEMA_VERSION,
    data: {
      eventDefinition: {
        id: "ed_signed_up",
        appId,
        name: "signed_up",
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

function kv(values: Map<string, string>) {
  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
  } as KVNamespace;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
