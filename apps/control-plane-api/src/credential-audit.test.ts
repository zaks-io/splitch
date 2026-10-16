import { envScope } from "@splitch/db";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  API_KEY,
  AUDIT_APP,
  AUDIT_ENV,
  AUDIT_ORG,
  CANARIES,
  CLIENT_KEY,
  type CredentialMembershipAuditFixture,
  credentialPath,
  MEMBER,
  makeCredentialMembershipAuditFixture,
  OTHER_APP,
  OTHER_ENV,
  SIBLING_ENV,
} from "./credential-membership-audit-fixture";

let fixture: CredentialMembershipAuditFixture;
beforeEach(async () => {
  fixture = await makeCredentialMembershipAuditFixture();
});
afterEach(async () => {
  await fixture?.dispose();
});

it("records each API Key create and revoke once, and does not audit a revoke retry", async () => {
  const secrets: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const response = await fixture.request("POST", credentialPath("api-keys"), {
      scopes: ["data-plane:evaluate"],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { credential: { keyId: string }; value: string };
    ids.push(body.credential.keyId);
    secrets.push(body.value);
    expect(await fixture.events()).toHaveLength(i + 1);
  }
  expect(new Set(ids).size).toBe(2);
  expect(new Set(secrets).size).toBe(2);
  let events = await fixture.events();
  expect(events.map((row) => row.action)).toEqual(["api_keys_create", "api_keys_create"]);
  expect(events.map((row) => row.resourceId)).toEqual(ids);
  expect(new Set(events.map((row) => row.eventId)).size).toBe(2);
  const keyId = ids[0];
  if (!keyId) throw new Error("API create did not return a resource");
  for (let i = 0; i < 2; i++) {
    const response = await fixture.request("POST", credentialPath(`api-keys/${keyId}/revoke`), {});
    expect(response.status).toBe(200);
    expect(await fixture.events()).toHaveLength(3);
  }
  events = await fixture.events();
  expect(events[2]).toMatchObject({
    action: "api_keys_revoke",
    resourceType: "credential",
    resourceId: keyId,
  });
  for (const row of events) {
    expect(row).toMatchObject({
      appId: AUDIT_APP,
      organizationId: AUDIT_ORG,
      environmentId: AUDIT_ENV,
    });
  }
  expect(
    await fixture.repo.credentials.getApiKey(envScope(AUDIT_APP, AUDIT_ENV), keyId),
  ).toMatchObject({ revokedAt: expect.any(String) });
  await fixture.expectSafeEvents(secrets);
});

it("audits Client Key patches only when state changes and omits allowlist values", async () => {
  const body = { originAllowlist: [CANARIES.origin], rateLimitRps: 50 };
  for (const patch of [body, body, {}]) {
    expect((await fixture.request("PATCH", credentialPath("client-key"), patch)).status).toBe(200);
    expect(await fixture.events()).toHaveLength(1);
  }
  expect((await fixture.events())[0]).toMatchObject({
    action: "client_key_update",
    resourceType: "credential",
    resourceId: CLIENT_KEY,
    appId: AUDIT_APP,
    organizationId: AUDIT_ORG,
    environmentId: AUDIT_ENV,
  });
  const event = (await fixture.events())[0];
  if (!event) throw new Error("Client Key patch did not emit an event");
  expect(JSON.parse(event.changesJson)).toEqual({
    changedFields: ["originAllowlist", "rateLimitRps"],
  });
  expect(
    await fixture.repo.credentials.getClientKey(envScope(AUDIT_APP, AUDIT_ENV), CLIENT_KEY),
  ).toMatchObject({
    rateLimitRps: 50,
    originAllowlist: JSON.stringify([CANARIES.origin]),
  });
  await fixture.expectSafeEvents();
});

it("records two Client Key rotations as distinct committed resources despite identical retry headers", async () => {
  const keys: string[] = [];
  const materials: string[] = [];
  for (let i = 0; i < 2; i++) {
    const response = await fixture.request("POST", credentialPath("client-key/revoke"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      newKey: { keyId: string; keyMaterial: string };
      revokedKeyId: string;
    };
    expect(body.revokedKeyId).toBe(i === 0 ? CLIENT_KEY : keys[0]);
    keys.push(body.newKey.keyId);
    materials.push(body.newKey.keyMaterial);
    expect(await fixture.events()).toHaveLength(i + 1);
  }
  const events = await fixture.events();
  expect(events.map((row) => row.action)).toEqual(["client_key_rotate", "client_key_rotate"]);
  expect(events.map((row) => row.resourceId)).toEqual(keys);
  expect(new Set(events.map((row) => row.eventId)).size).toBe(2);
  expect(new Set(keys).size).toBe(2);
  const stored = await fixture.repo.credentials.listClientKeys(envScope(AUDIT_APP, AUDIT_ENV));
  expect(stored).toHaveLength(3);
  expect(stored.filter((row) => row.revokedAt === null).map((row) => row.keyId)).toEqual([keys[1]]);
  await fixture.expectSafeEvents(materials);
});

it("does not audit malformed, refused, missing, cross-App or cross-Environment attempts", async () => {
  const memberApp = fixture.appFor({ id: MEMBER });
  for (const [method, suffix, body] of [
    ["POST", "api-keys", { scopes: ["invalid-scope"] }],
    ["POST", "api-keys", { scopes: [], actorRef: CANARIES.actor, context: CANARIES.context }],
    ["PATCH", "client-key", { rateLimitRps: -1 }],
    ["PATCH", "client-key", { targetingKey: CANARIES.targetingKey, keyMaterial: CANARIES.client }],
    ["POST", "api-keys/missing/revoke", {}],
    ["POST", "api-keys/ak_audit_other/revoke", {}],
    ["POST", "api-keys/ak_audit_sibling/revoke", {}],
  ] as const) {
    const response = await fixture.request(method, credentialPath(suffix), body);
    expect([400, 404]).toContain(response.status);
  }
  for (const [method, suffix, body] of [
    ["POST", "api-keys", { scopes: [] }],
    ["POST", `api-keys/${API_KEY}/revoke`, {}],
    ["PATCH", "client-key", { rateLimitRps: 50 }],
    ["POST", "client-key/revoke", undefined],
  ] as const) {
    expect((await fixture.request(method, credentialPath(suffix), body, memberApp)).status).toBe(
      403,
    );
  }
  expect(
    (
      await fixture.request("POST", `/apps/${OTHER_APP}/envs/${OTHER_ENV}/api-keys`, {
        scopes: [],
      })
    ).status,
  ).toBe(403);
  const envBound = fixture.appFor({ environmentId: AUDIT_ENV });
  expect(
    (
      await fixture.request(
        "PATCH",
        credentialPath("client-key", SIBLING_ENV),
        { rateLimitRps: 50 },
        envBound,
      )
    ).status,
  ).toBe(403);
  expect(await fixture.events()).toEqual([]);
  expect(await fixture.events(OTHER_APP)).toEqual([]);
});

it("keeps sibling and other-App credentials and audit histories isolated after successful writes", async () => {
  const otherBefore = await fixture.repo.credentials.listClientKeys(envScope(OTHER_APP, OTHER_ENV));
  const siblingBefore = await fixture.repo.credentials.listClientKeys(
    envScope(AUDIT_APP, SIBLING_ENV),
  );
  expect(
    (await fixture.request("PATCH", credentialPath("client-key"), { rateLimitRps: 50 })).status,
  ).toBe(200);
  expect(
    (await fixture.request("POST", credentialPath(`api-keys/${API_KEY}/revoke`), {})).status,
  ).toBe(200);
  expect(await fixture.repo.credentials.listClientKeys(envScope(OTHER_APP, OTHER_ENV))).toEqual(
    otherBefore,
  );
  expect(await fixture.repo.credentials.listClientKeys(envScope(AUDIT_APP, SIBLING_ENV))).toEqual(
    siblingBefore,
  );
  expect(
    await fixture.repo.credentials.getApiKey(envScope(AUDIT_APP, SIBLING_ENV), "ak_audit_sibling"),
  ).toMatchObject({ revokedAt: null });
  expect(await fixture.events(OTHER_APP)).toEqual([]);
  expect((await fixture.events()).map((row) => row.environmentId)).toEqual([AUDIT_ENV, AUDIT_ENV]);
});

it.each([
  ["create", "POST", "api-keys", { scopes: [] }],
  ["revoke", "POST", `api-keys/${API_KEY}/revoke`, {}],
  ["patch", "PATCH", "client-key", { rateLimitRps: 50 }],
  ["rotate", "POST", "client-key/revoke", undefined],
] as const)(
  "rolls back credential %s when the audit INSERT fails in real D1",
  async (_name, method, suffix, body) => {
    const scope = envScope(AUDIT_APP, AUDIT_ENV);
    const beforeApi = await fixture.repo.credentials.listApiKeys(scope);
    const beforeClient = await fixture.repo.credentials.listClientKeys(scope);
    await fixture.failAuditInsert();
    expect((await fixture.request(method, credentialPath(suffix), body)).status).toBe(500);
    expect(fixture.faults).toEqual([{ auditInsertRejected: true }]);
    expect(await fixture.repo.credentials.listApiKeys(scope)).toEqual(beforeApi);
    expect(await fixture.repo.credentials.listClientKeys(scope)).toEqual(beforeClient);
    expect(await fixture.events()).toEqual([]);
  },
);
