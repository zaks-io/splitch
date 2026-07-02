import {
  apiKeyCacheKey,
  clientKeyCacheKey,
  CredentialCacheKVSchema,
  experimentConfigKey,
  flagConfigKey,
  type ErrorResponse,
} from "@splitch/contracts";
import type { AuthResolver, RateLimiter } from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { makeDataPlaneAuthResolver, sha256Hex } from "./data-plane-auth.js";
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
import { experimentConfigKV, flagConfigKV } from "./provider/fixtures.js";
import { KvProvider } from "./provider/kv-provider.js";

const PATH = "/api/sdk/verify";
const CLIENT_KEY = "pk_verify_client";
const LOCKED_CLIENT_KEY = "pk_verify_locked";
const API_KEY = "sk_verify_api";
const UNSCOPED_API_KEY = "sk_verify_unscoped";
const REVOKED_CLIENT_KEY = "pk_verify_revoked";

const allowLimiter: RateLimiter = () => ({ limited: false });
const controlPlaneAuthResolver: AuthResolver = () => ({ ok: false, reason: "UNAUTHORIZED" });

function seededConfigKv(): FakeKv {
  return new FakeKv()
    .put(
      flagConfigKey(APP_ID, ENVIRONMENT_ID, FLAG_KEY),
      flagConfigKV({
        experimentId: EXPERIMENT_ID,
        targetingRules: [targetingRule({ id: "rule-enterprise" })],
      }),
    )
    .put(
      experimentConfigKey(APP_ID, ENVIRONMENT_ID, EXPERIMENT_ID),
      experimentConfigKV({ liveRunId: null, status: "draft" }),
    );
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

async function makeHarness() {
  const configKv = seededConfigKv();
  const credentialKv = await seededCredentialKv();
  const assignmentStore = new RecordingAssignmentStore();
  const app = createApp({
    authResolver: controlPlaneAuthResolver,
    dataPlaneAuthResolver: makeDataPlaneAuthResolver(credentialKv),
    rateLimiter: allowLimiter,
    provider: new KvProvider(configKv),
    assignmentStore,
  });
  return { app, assignmentStore, configKv, credentialKv };
}

function verifyInit(credential?: string, extraHeaders: Record<string, string> = {}): RequestInit {
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
    }),
  };
}

describe("POST /api/sdk/verify", () => {
  it("returns non-revealing ResolutionDetails under a Client Key", async () => {
    const { app, assignmentStore } = await makeHarness();

    const res = await app.request(PATH, verifyInit(CLIENT_KEY));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toEqual({
      value: true,
      variantName: "treatment",
      reason: "SPLIT",
    });
    expect(JSON.stringify(body)).not.toContain("rule-enterprise");
    expect(JSON.stringify(body)).not.toContain("rollout");
    expect(JSON.stringify(body)).not.toContain("salt");
    expect(assignmentStore.putCalls).toEqual([]);
  });

  it("returns TARGETING_MATCH with ruleId under an API Key", async () => {
    const { app, assignmentStore } = await makeHarness();

    const res = await app.request(PATH, verifyInit(API_KEY));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      value: true,
      variantName: "treatment",
      reason: "TARGETING_MATCH",
      ruleId: "rule-enterprise",
    });
    expect(assignmentStore.putCalls).toEqual([]);
  });

  it("rejects an API Key without data-plane:evaluate before evaluation", async () => {
    const { app, assignmentStore } = await makeHarness();

    const res = await app.request(PATH, verifyInit(UNSCOPED_API_KEY));
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(403);
    expect(body.code).toBe("INSUFFICIENT_SCOPES");
    expect(assignmentStore.getAllCalls).toEqual([]);
    expect(assignmentStore.putCalls).toEqual([]);
  });

  it("enforces a Client Key origin allow-list before evaluation", async () => {
    const allowedHarness = await makeHarness();
    const allowed = await allowedHarness.app.request(
      PATH,
      verifyInit(LOCKED_CLIENT_KEY, { origin: "https://app.example.test" }),
    );

    expect(allowed.status).toBe(200);
    expect(allowedHarness.assignmentStore.getAllCalls).toHaveLength(1);
    expect(allowedHarness.assignmentStore.putCalls).toEqual([]);

    const blockedHarness = await makeHarness();
    const blocked = await blockedHarness.app.request(
      PATH,
      verifyInit(LOCKED_CLIENT_KEY, { origin: "https://evil.example.test" }),
    );
    const body = (await blocked.json()) as ErrorResponse;

    expect(blocked.status).toBe(403);
    expect(body).toEqual({
      code: "ORIGIN_NOT_ALLOWED",
      message: "origin is not allowed for this Client Key",
      details: {
        origin: "https://evil.example.test",
        hint: "add this origin to the Client Key allow-list or open the key",
      },
    });
    expect(blockedHarness.assignmentStore.getAllCalls).toEqual([]);
    expect(blockedHarness.assignmentStore.putCalls).toEqual([]);
  });

  it("is repeatable without Assignment Store writes", async () => {
    const { app, assignmentStore, configKv, credentialKv } = await makeHarness();

    await app.request(PATH, verifyInit(CLIENT_KEY));
    await app.request(PATH, verifyInit(CLIENT_KEY));

    expect(assignmentStore.getAllCalls).toHaveLength(2);
    expect(assignmentStore.putCalls).toEqual([]);
    expect(configKv.getCalls).toEqual([
      flagConfigKey(APP_ID, ENVIRONMENT_ID, FLAG_KEY),
      experimentConfigKey(APP_ID, ENVIRONMENT_ID, EXPERIMENT_ID),
      experimentConfigKey(APP_ID, ENVIRONMENT_ID, EXPERIMENT_ID),
    ]);
    expect(credentialKv.getCalls).toEqual([
      clientKeyCacheKey(await sha256Hex(CLIENT_KEY)),
      clientKeyCacheKey(await sha256Hex(CLIENT_KEY)),
    ]);
  });

  it("rejects missing and revoked credentials before evaluation", async () => {
    const { app, assignmentStore } = await makeHarness();

    const missing = await app.request(PATH, verifyInit());
    const revoked = await app.request(PATH, verifyInit(REVOKED_CLIENT_KEY));

    expect(missing.status).toBe(401);
    expect(((await missing.json()) as ErrorResponse).code).toBe("UNAUTHORIZED");
    expect(revoked.status).toBe(403);
    expect(((await revoked.json()) as ErrorResponse).code).toBe("CREDENTIAL_REVOKED");
    expect(assignmentStore.getAllCalls).toEqual([]);
    expect(assignmentStore.putCalls).toEqual([]);
  });
});
