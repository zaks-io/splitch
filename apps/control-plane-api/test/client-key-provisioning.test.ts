import {
  CredentialCacheKVSchema,
  clientKeyCacheKey,
  DEFAULT_CLIENT_KEY_RATE_LIMIT_RPS,
  kvEnvelope,
} from "@splitch/contracts";
import { createRepository, envScope, type Repository } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { readOrProvisionClientKey } from "../src/client-key-provisioning";
import { sha256Hex } from "../src/credential-cache";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { makeSessionStore } from "../src/session-store";
import type { LocalBindings } from "../src/test-fixtures";
import { seedAppMember, seedEnvironment, seedOrgApp } from "../src/test-seeds";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 6, 2, 12, 0, 0);
const APP = {
  orgId: "org_client_key_race",
  orgName: "Client Key Race Co",
  appId: "app_client_key_race",
  appName: "Client Key Race App",
  appKey: "client-key-race",
};
const ENV = { environmentId: "env_client_key_race_prod", key: "prod" };
const SETTINGS_ENV = { environmentId: "env_client_key_settings_read", key: "settings-read" };
const ADMIN = "user_client_key_race_admin";

const allowLimiter: RateLimiter = () => ({ limited: false });

interface Harness {
  app: Hono;
  signer: FixtureSigner;
  bindings: LocalBindings;
}

let h: Harness;

// The Workers pool isolates storage per FILE, not per test (isolatedStorage was
// dropped in the Vitest 4 migration -- workers-sdk#12889), so the fixed-ID seed
// rows are inserted once here instead of in `beforeEach`, which would trip the
// slug unique index on the second test. Each test still gets its own harness.
beforeAll(async () => {
  const bindings = await makeLocalBindings();
  await seedOrgApp(bindings.d1, APP);
  await seedAppMember(bindings.d1, { appId: APP.appId, userId: ADMIN, role: "admin" });
  await seedEnvironment(bindings.d1, { appId: APP.appId, ...ENV });
  await seedEnvironment(bindings.d1, { appId: APP.appId, ...SETTINGS_ENV });
});

beforeEach(async () => {
  const bindings = await makeLocalBindings();
  const signer = await makeFixtureSigner();
  h = { app: makeApp(bindings, signer), signer, bindings };
});

afterEach(async () => h.bindings.dispose());

function makeApp(
  bindings: LocalBindings,
  signer: FixtureSigner,
  repo: Repository = createRepository(bindings.d1),
  credentialStore: KVNamespace = bindings.credentialKv,
) {
  const verifier = makeJwksVerifier({
    fetchJwks: async () => signer.jwks,
    controlPlaneAudience: AUDIENCE,
  });
  return createApp({
    authResolver: makeControlPlaneAuthResolver({
      verifier,
      sessions: makeSessionStore(bindings.kv),
      membershipAccess: { authorize: async () => true },
      now: () => NOW_MS,
    }),
    rateLimiter: allowLimiter,
    repo,
    credentialStore,
    nowIso: () => new Date(NOW_MS).toISOString(),
  });
}

function token(): Promise<string> {
  return h.signer.sign({
    sub: ADMIN,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: Math.floor(NOW_MS / 1000),
    exp: Math.floor(NOW_MS / 1000) + 3600,
    scopes: [`app:${APP.appId}:admin`],
  });
}

async function request(jwt: string): Promise<Response> {
  return h.app.request(`/apps/${APP.appId}/envs/${ENV.environmentId}/client-key`, {
    method: "GET",
    headers: { authorization: `Bearer ${jwt}` },
  });
}

describe("control-plane Client Key provisioning", () => {
  it("writes the credential cache only when a Settings read creates the key", async () => {
    const repo = createRepository(h.bindings.d1);
    const writes: string[] = [];
    const credentialStore = {
      put: async (key: string) => {
        writes.push(key);
      },
    } as unknown as KVNamespace;
    const ctx = {
      appId: APP.appId,
      environmentId: SETTINGS_ENV.environmentId,
      organizationId: APP.orgId,
      scope: envScope(APP.appId, SETTINGS_ENV.environmentId),
    };

    const first = await readOrProvisionClientKey({ repo, credentialStore }, ctx);
    const second = await readOrProvisionClientKey({ repo, credentialStore }, ctx);

    expect(second.keyId).toBe(first.keyId);
    expect(writes).toHaveLength(1);
  });

  it("keeps lazy provisioning single-active under stale concurrent reads", async () => {
    const jwt = await token();
    const realRepo = createRepository(h.bindings.d1);
    let staleReads = 0;
    const releases: Array<() => void> = [];
    const racingRepo = {
      ...realRepo,
      credentials: {
        ...realRepo.credentials,
        listClientKeys(scope) {
          if (staleReads >= 2) return realRepo.credentials.listClientKeys(scope);
          staleReads += 1;
          return new Promise((resolve) => {
            releases.push(() => resolve([]));
            if (releases.length === 2) {
              for (const release of releases) release();
            }
          });
        },
      },
    } satisfies Repository;
    h.app = makeApp(h.bindings, h.signer, racingRepo);

    const [first, second] = await Promise.all([request(jwt), request(jwt)]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const [firstBody, secondBody] = (await Promise.all([first.json(), second.json()])) as [
      { keyId: string },
      { keyId: string },
    ];
    expect(firstBody.keyId).toBe(secondBody.keyId);

    const rows = await realRepo.credentials.listClientKeys(envScope(APP.appId, ENV.environmentId));
    expect(rows.filter((row) => !row.revokedAt)).toHaveLength(1);
  });

  it("fails loud when provisioning cannot write through to KV", async () => {
    const jwt = await token();
    h.app = makeApp(h.bindings, h.signer, createRepository(h.bindings.d1), faultingKv());

    const response = await request(jwt);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("fails loud when rotation cannot write the replacement through to KV", async () => {
    const jwt = await token();
    expect((await request(jwt)).status).toBe(200);

    let writes = 0;
    const store = faultingKv(() => {
      writes += 1;
      if (writes === 2) throw new Error("KV unavailable");
    });
    h.app = makeApp(h.bindings, h.signer, createRepository(h.bindings.d1), store);

    const response = await clientKeyRequest("POST", "/revoke", jwt, {});

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(writes).toBe(2);
  });

  it("provisions Client Keys at the ADR 100 rps default and writes it through to KV", async () => {
    const jwt = await token();
    const response = await request(jwt);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      keyMaterial: string;
      rateLimitRps: number | null;
    };
    expect(body.rateLimitRps).toBe(DEFAULT_CLIENT_KEY_RATE_LIMIT_RPS);

    const rows = (
      await createRepository(h.bindings.d1).credentials.listClientKeys(
        envScope(APP.appId, ENV.environmentId),
      )
    ).filter((row) => !row.revokedAt);
    expect(rows).toEqual([expect.objectContaining({ rateLimitRps: 100 })]);

    const raw = await h.bindings.credentialKv.get(
      clientKeyCacheKey(await sha256Hex(body.keyMaterial)),
      "text",
    );
    expect(raw).not.toBeNull();
    expect(kvEnvelope(CredentialCacheKVSchema).parse(JSON.parse(raw as string)).data).toMatchObject(
      {
        rateLimitRps: 100,
      },
    );
  });

  it("fails loud when a restriction cache write throws", async () => {
    const jwt = await token();
    expect((await request(jwt)).status).toBe(200);
    h.app = makeApp(h.bindings, h.signer, createRepository(h.bindings.d1), faultingKv());

    const response = await clientKeyRequest("PATCH", "", jwt, {
      originAllowlist: ["https://app.example.test"],
      rateLimitRps: 25,
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });
});

async function clientKeyRequest(
  method: string,
  suffix: string,
  jwt: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return h.app.request(`/apps/${APP.appId}/envs/${ENV.environmentId}/client-key${suffix}`, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function faultingKv(
  onPut: () => void = () => {
    throw new Error("KV unavailable");
  },
): KVNamespace {
  return { put: async () => onPut() } as unknown as KVNamespace;
}
