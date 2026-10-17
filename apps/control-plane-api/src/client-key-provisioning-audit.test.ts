import { clientKeyCacheKey, DEFAULT_CLIENT_KEY_RATE_LIMIT_RPS } from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sha256Hex } from "./credential-cache";
import {
  AUDIT_APP,
  AUDIT_ENV,
  CLIENT_KEY,
  type CredentialMembershipAuditFixture,
  credentialPath,
  makeCredentialMembershipAuditFixture,
} from "./credential-membership-audit-fixture";

let fixture: CredentialMembershipAuditFixture;
const scope = envScope(AUDIT_APP, AUDIT_ENV);

beforeEach(async () => {
  fixture = await makeCredentialMembershipAuditFixture();
  await fixture.repo.credentials.removeClientKey(scope, CLIENT_KEY);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture?.dispose();
});

it.each([{}, { rateLimitRps: DEFAULT_CLIENT_KEY_RATE_LIMIT_RPS }, { rateLimitRps: 50 }])(
  "audits lazy provisioning and PATCH %j as one committed credential",
  async (patch) => {
    const published = vi.fn<KVNamespace["put"]>(async (...args) => {
      expect(await fixture.events()).toHaveLength(1);
      expect(await fixture.repo.credentials.listClientKeys(scope)).toHaveLength(1);
      return fixture.credentialKv.put(...args);
    });
    const app = fixture.appFor({}, { put: published } as unknown as KVNamespace);
    const response = await fixture.request("PATCH", credentialPath("client-key"), patch, app);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { keyId: string; keyMaterial: string };
    const rows = await fixture.repo.credentials.listClientKeys(scope);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      keyId: body.keyId,
      keyMaterial: body.keyMaterial,
      rateLimitRps:
        "rateLimitRps" in patch ? patch.rateLimitRps : DEFAULT_CLIENT_KEY_RATE_LIMIT_RPS,
      revokedAt: null,
    });
    expect(await fixture.events()).toMatchObject([
      { action: "client_key_update", resourceId: body.keyId, environmentId: AUDIT_ENV },
    ]);
    expect(await cachedCredential(body.keyMaterial)).toMatchObject({
      data: { revoked: false, rateLimitRps: rows[0]?.rateLimitRps },
    });
    expect(published).toHaveBeenCalledOnce();
    const event = (await fixture.events())[0];
    expect((await fixture.request("PATCH", credentialPath("client-key"), patch)).status).toBe(200);
    expect(await fixture.events()).toEqual([event]);
    expect(await fixture.repo.credentials.listClientKeys(scope)).toEqual(rows);
    await fixture.expectSafeEvents([body.keyMaterial]);
  },
);

it.each([
  ["PATCH", "client-key", {}, 1, 1],
  ["POST", "client-key/revoke", undefined, 2, 3],
] as const)(
  "keeps concurrent missing-key %s calls atomic without adding credential replay",
  async (method, suffix, body, eventCount, keyCount) => {
    staleInitialReads();
    const responses = await Promise.all([
      fixture.request(method, credentialPath(suffix), body),
      fixture.request(method, credentialPath(suffix), body),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const rows = await fixture.repo.credentials.listClientKeys(scope);
    expect(rows).toHaveLength(keyCount);
    expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1);
    const events = await fixture.events();
    expect(events).toHaveLength(eventCount);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(eventCount);
    expect(new Set(events.map((event) => event.resourceId)).size).toBe(eventCount);
  },
);

it("applies a different PATCH to the concurrent provisioner's key", async () => {
  staleInitialReads();
  const responses = await Promise.all(
    [50, 25].map((rateLimitRps) =>
      fixture.request("PATCH", credentialPath("client-key"), { rateLimitRps }),
    ),
  );
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  const bodies = (await Promise.all(responses.map((response) => response.json()))) as {
    keyId: string;
    rateLimitRps: number;
  }[];
  expect(bodies.map((body) => body.rateLimitRps)).toEqual([50, 25]);
  expect(new Set(bodies.map((body) => body.keyId)).size).toBe(1);
  expect(await fixture.repo.credentials.listClientKeys(scope)).toHaveLength(1);
  expect(await fixture.events()).toMatchObject([
    { action: "client_key_update", resourceId: bodies[0]?.keyId },
    { action: "client_key_update", resourceId: bodies[0]?.keyId },
  ]);
});

it.each([
  ["empty PATCH", "PATCH", "client-key", {}],
  ["PATCH", "PATCH", "client-key", { rateLimitRps: 50 }],
  ["rotation", "POST", "client-key/revoke", undefined],
] as const)(
  "rolls back lazy provisioning and publishes no cache after a rejected %s audit",
  async (_name, method, path, body) => {
    const cachedBefore = await fixture.credentialKv.list();
    await fixture.failAuditInsert();
    expect((await fixture.request(method, credentialPath(path), body)).status).toBe(500);
    expect(fixture.faults).toEqual([{ auditInsertRejected: true }]);
    expect(await fixture.repo.credentials.listClientKeys(scope)).toEqual([]);
    expect(await fixture.events()).toEqual([]);
    expect(await fixture.credentialKv.list()).toEqual(cachedBefore);
  },
);

it("commits lazy provisioning, revocation, replacement and one rotation audit together", async () => {
  const response = await fixture.request("POST", credentialPath("client-key/revoke"));
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    newKey: { keyId: string; keyMaterial: string };
    revokedKeyId: string;
  };
  const rows = await fixture.repo.credentials.listClientKeys(scope);
  expect(rows).toHaveLength(2);
  const revoked = rows.find((row) => row.keyId === body.revokedKeyId);
  expect(revoked).toMatchObject({ revokedAt: expect.any(String) });
  expect(rows.filter((row) => row.revokedAt === null)).toMatchObject([
    { keyId: body.newKey.keyId, keyMaterial: body.newKey.keyMaterial },
  ]);
  const events = await fixture.events();
  expect(events).toMatchObject([
    { action: "client_key_rotate", resourceId: body.newKey.keyId, environmentId: AUDIT_ENV },
  ]);
  expect(JSON.parse(events[0]?.changesJson ?? "null")).toEqual({ revokedKeyId: body.revokedKeyId });
  expect(await cachedCredential(body.newKey.keyMaterial)).toMatchObject({
    data: { revoked: false },
  });
  if (!revoked) throw new Error("rotation did not return a revoked credential");
  expect(await cachedCredential(revoked.keyMaterial)).toMatchObject({ data: { revoked: true } });
  await fixture.expectSafeEvents(rows.map((row) => row.keyMaterial));
});

it("does not write or audit an unchanged existing credential", async () => {
  // An audit trigger would reject a write; this path must never reach it.
  expect((await fixture.request("PATCH", credentialPath("client-key"), {})).status).toBe(200);
  const rows = await fixture.repo.credentials.listClientKeys(scope);
  const events = await fixture.events();
  await fixture.failAuditInsert();
  await fixture.d1.exec(
    "CREATE TRIGGER reject_test_client_update BEFORE UPDATE ON client_keys BEGIN SELECT RAISE(ABORT, 'unchanged credential must not be updated'); END;",
  );
  for (const patch of [{}, { rateLimitRps: DEFAULT_CLIENT_KEY_RATE_LIMIT_RPS }]) {
    expect((await fixture.request("PATCH", credentialPath("client-key"), patch)).status).toBe(200);
  }
  expect(await fixture.repo.credentials.listClientKeys(scope)).toEqual(rows);
  expect(await fixture.events()).toEqual(events);
  expect(fixture.faults).toEqual([]);
});

async function cachedCredential(keyMaterial: string) {
  const value = await fixture.credentialKv.get(clientKeyCacheKey(await sha256Hex(keyMaterial)));
  return value === null ? null : JSON.parse(value);
}

function staleInitialReads() {
  const list = fixture.repo.credentials.listClientKeys.bind(fixture.repo.credentials);
  const releases: (() => void)[] = [];
  vi.spyOn(fixture.repo.credentials, "listClientKeys").mockImplementation((readScope) => {
    if (releases.length === 2) return list(readScope);
    return new Promise((resolve) => {
      releases.push(() => resolve([]));
      if (releases.length === 2) for (const release of releases) release();
    });
  });
}
