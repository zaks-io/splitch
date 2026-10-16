import { appScope, createRepository, envScope, type Repository } from "@splitch/db";
import { DELEGATED_IDENTITY_HEADER, type Principal } from "@splitch/worker-runtime";
import { expect } from "vitest";
import { auditLogEvent } from "./audit-events";
import { makeTestApp } from "./test-app-fixture";
import { makeLocalBindings } from "./test-fixtures";
import { seedAppMember, seedEnvironment, seedOrgApp, seedOrgMember } from "./test-seeds";

const AUDIT_NOW = "2026-10-16T12:00:00.000Z";
export const AUDIT_APP = "app_audit_credentials";
export const AUDIT_ENV = "env_audit_credentials";
export const AUDIT_ORG = "org_audit_credentials";
export const OTHER_APP = "app_audit_other";
export const OTHER_ENV = "env_audit_other";
export const SIBLING_ENV = "env_audit_sibling";
export const OWNER = "user_audit_owner";
export const MEMBER = "user_audit_member";
export const CANDIDATE = "user_audit_candidate";
export const API_KEY = "ak_audit_existing";
export const CLIENT_KEY = "ck_audit_existing";

export const CANARIES = {
  bearer: "CANARY_BEARER_AUDIT_161",
  apiRaw: "sk_CANARY_API_RAW_AUDIT_161",
  apiHash: "CANARY_API_HASH_AUDIT_161",
  client: "pk_CANARY_CLIENT_MATERIAL_AUDIT_161",
  context: "CANARY_EVALUATION_CONTEXT_AUDIT_161",
  targetingKey: "CANARY_TARGETING_KEY_AUDIT_161",
  actor: "user_spoofed_audit_actor",
  origin: "https://canary-origin-audit-161.example",
} as const;

type TestApp = ReturnType<typeof makeTestApp>;
export interface CredentialMembershipAuditFixture
  extends Awaited<ReturnType<typeof makeLocalBindings>> {
  repo: Repository;
  app: TestApp;
  appFor: (overrides?: Partial<Principal>) => TestApp;
  request: (
    method: string,
    path: string,
    body?: unknown,
    target?: TestApp,
  ) => Response | Promise<Response>;
  events: (appId?: string) => ReturnType<Repository["auditEvents"]["list"]>;
  expectSafeEvents: (extraCanaries?: string[]) => Promise<void>;
  failAuditInsert: () => Promise<void>;
  faults: { auditInsertRejected: boolean }[];
}

export async function makeCredentialMembershipAuditFixture(): Promise<CredentialMembershipAuditFixture> {
  const local = await makeLocalBindings();
  const repo: Repository = createRepository(local.d1);
  const faults: { auditInsertRejected: boolean }[] = [];
  for (const [orgId, appId, environmentId] of [
    [AUDIT_ORG, AUDIT_APP, AUDIT_ENV],
    ["org_audit_other", OTHER_APP, OTHER_ENV],
  ] as const) {
    await seedOrgApp(local.d1, { orgId, appId, orgName: orgId, appName: appId, appKey: appId });
    await seedEnvironment(local.d1, { appId, environmentId, key: environmentId });
  }
  await seedEnvironment(local.d1, { appId: AUDIT_APP, environmentId: SIBLING_ENV, key: "sibling" });
  for (const [userId, role] of [
    [OWNER, "owner"],
    [MEMBER, "member"],
    [CANDIDATE, "member"],
  ] as const) {
    await seedOrgMember(local.d1, { orgId: AUDIT_ORG, userId, role });
    if (userId !== CANDIDATE) await seedAppMember(local.d1, { appId: AUDIT_APP, userId, role });
  }
  await seedOrgMember(local.d1, { orgId: "org_audit_other", userId: MEMBER, role: "owner" });
  await seedAppMember(local.d1, { appId: OTHER_APP, userId: MEMBER, role: "owner" });
  for (const [appId, environmentId, suffix] of [
    [AUDIT_APP, AUDIT_ENV, "existing"],
    [AUDIT_APP, SIBLING_ENV, "sibling"],
    [OTHER_APP, OTHER_ENV, "other"],
  ] as const) {
    const scope = envScope(appId, environmentId);
    await repo.credentials.apiKeys.insert(scope, {
      keyId: `ak_audit_${suffix}`,
      appId,
      environmentId,
      keyHash: CANARIES.apiHash + suffix,
      scopes: '["data-plane:evaluate"]',
      createdAt: AUDIT_NOW,
      createdBy: OWNER,
    });
    await repo.credentials.clientKeys.insert(scope, {
      keyId: `ck_audit_${suffix}`,
      appId,
      environmentId,
      keyMaterial: CANARIES.client + suffix,
      originAllowlist: null,
      rateLimitRps: 100,
      createdAt: AUDIT_NOW,
    });
  }

  function appFor(overrides: Partial<Principal> = {}) {
    const principal: Principal = {
      id: OWNER,
      kind: "control-plane-token",
      appId: AUDIT_APP,
      orgId: AUDIT_ORG,
      environmentId: null,
      authDoor: "device_flow",
      scopes: [`app:${AUDIT_APP}:owner`],
      ...overrides,
    };
    return makeTestApp({
      repo,
      credentialStore: local.credentialKv,
      nowIso: () => AUDIT_NOW,
      authResolver: () => ({ ok: true, principal }),
      observability: {
        onError({ cause }) {
          if (cause) faults.push({ auditInsertRejected: causedByAuditTrigger(cause) });
        },
      },
    });
  }

  const app = appFor();
  function request(method: string, path: string, body?: unknown, target = app) {
    return target.request(path, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${CANARIES.bearer}`,
        "x-actor-ref": CANARIES.actor,
        "x-user-id": CANARIES.actor,
        "x-auth-method": "spoofed",
        [DELEGATED_IDENTITY_HEADER]: JSON.stringify({
          userId: CANARIES.actor,
          authDoor: "spoofed",
        }),
        "x-evaluation-context": CANARIES.context,
        "x-targeting-key": CANARIES.targetingKey,
        "x-api-key": CANARIES.apiRaw,
        "x-client-key": CANARIES.client,
        "idempotency-key": "same-audit-request",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function events(appId = AUDIT_APP) {
    return repo.auditEvents.list(appScope(appId));
  }

  async function expectSafeEvents(extraCanaries: string[] = []) {
    const rows = await repo.auditEvents.listPending(100);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatchObject({
        actorRef: OWNER,
        actorVia: "device_flow",
        outcome: "committed",
        changedAt: AUDIT_NOW,
      });
      const payload = JSON.stringify({ outbox: row, analytics: auditLogEvent(row) });
      for (const canary of [...Object.values(CANARIES), ...extraCanaries]) {
        expect(payload).not.toContain(canary);
      }
    }
  }

  async function failAuditInsert() {
    await local.d1.exec(
      "CREATE TRIGGER reject_test_audit BEFORE INSERT ON control_plane_audit_events BEGIN SELECT RAISE(ABORT, 'test audit insert refused'); END;",
    );
  }

  return {
    ...local,
    repo,
    app,
    appFor,
    request,
    events,
    expectSafeEvents,
    failAuditInsert,
    faults,
  };
}

function causedByAuditTrigger(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return cause.message.includes("test audit insert refused") || causedByAuditTrigger(cause.cause);
}

export const credentialPath = (suffix: string, environmentId = AUDIT_ENV) =>
  `/apps/${AUDIT_APP}/envs/${environmentId}/${suffix}`;
export const membershipPath = (userId?: string, appId = AUDIT_APP) =>
  `/apps/${appId}/members${userId ? `/${userId}` : ""}`;
