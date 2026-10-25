import { getRoute } from "@splitch/contracts";
import { appScope, createRepository, type Repository } from "@splitch/db";
import {
  delegatedAuthResolver,
  delegatedIdentityFor,
  type Principal,
} from "@splitch/worker-runtime";
import { createApp as createAnalysisApp } from "../../analysis-api/src/app";
import { createTinybirdReadTransport } from "../../analysis-api/src/tinybird";
import { createTinybirdDeleteTransport } from "../../analysis-api/src/tinybird-delete";
import type { ControlPlaneApiEnv } from "../src/env";
import { makeTestApp } from "../src/test-app-fixture";
import { type LocalBindings, makeLocalBindings } from "../src/test-fixtures";
import { seedAppMember, seedEnvironment, seedOrgApp, seedOrgMember } from "../src/test-seeds";

export function makeAuditTinybirdReader(input: {
  bindings: LocalBindings;
  repo: Repository;
  principal: Principal;
  nowIso?: () => string;
}) {
  const apiUrl = process.env.SPLITCH_TEST_TINYBIRD_API_URL;
  const token = process.env.SPLITCH_TEST_TINYBIRD_TOKEN;
  if (!apiUrl || !token)
    throw new Error("Run the audit integration proof through pnpm tinybird:local");
  const { bindings, repo, principal } = input;
  let currentPrincipal = principal;
  const readCalls: string[] = [];
  const network = fetch;
  const analysisEnv = { TINYBIRD_API_URL: apiUrl, TINYBIRD_READ_TOKEN: token };
  const tinybird = createTinybirdReadTransport(analysisEnv, {
    fetchFn: async (request, init) => {
      readCalls.push(new URL(String(request)).pathname);
      return network(request, init);
    },
  });
  const auditRoute = getRoute("app_audit_list");
  if (!auditRoute) throw new Error("Missing audit route");
  const analysis = {
    async fetch(request: Request) {
      const identity = delegatedIdentityFor(request, [auditRoute]);
      if (!identity) throw new Error("Missing delegated audit identity");
      return createAnalysisApp({
        door: "binding",
        tinybird,
        tinybirdDelete: createTinybirdDeleteTransport(analysisEnv),
        authResolver: delegatedAuthResolver(identity),
        rateLimiter: () => ({ limited: false }),
      }).fetch(request);
    },
  } as unknown as Fetcher;
  const app = makeTestApp({
    repo,
    credentialStore: bindings.credentialKv,
    nowIso: input.nowIso,
    authResolver: () => ({ ok: true, principal: currentPrincipal }),
    delegationBindings: { "analysis-api": analysis },
  });
  const env = {
    DB: bindings.d1,
    SESSION_STORE: bindings.kv,
    INTEGRATION_DELIVERY_MODE: "cron",
    SPLITCH_PLATFORM_TARGET: "local",
    TINYBIRD_API_URL: apiUrl,
    TINYBIRD_APPROVAL_ARCHIVE_WRITE_TOKEN: token,
    CONVEX_WEBHOOK_KEK: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    CONVEX_WEBHOOK_KEY_VERSION: "v1",
    PRIVACY_JOBS_QUEUE: { send: async () => undefined },
    PRIVACY_EXPORTS: { delete: async () => undefined },
  } as unknown as ControlPlaneApiEnv;
  return {
    app,
    env,
    readCalls,
    network,
    apiUrl,
    token,
    become: (value: Principal) => {
      currentPrincipal = value;
    },
  };
}

async function seedAuditScope(bindings: LocalBindings) {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const appId = `app_audit_${suffix}`;
  const otherAppId = `app_other_${suffix}`;
  const environmentId = `env_${suffix}`;
  const orgId = `org_${suffix}`;
  const owner = `owner_${suffix}`;
  const member = `member_${suffix}`;
  const orgAdmin = `org_admin_${suffix}`;
  await seedOrgApp(bindings.d1, {
    orgId,
    appId,
    orgName: "Audit proof",
    appName: "Audit proof",
    appKey: appId,
  });
  await bindings.d1
    .prepare(
      "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?,?,'Other',?,?,?)",
    )
    .bind(otherAppId, orgId, otherAppId, new Date().toISOString(), new Date().toISOString())
    .run();
  await seedEnvironment(bindings.d1, { appId, environmentId, key: "dev" });
  for (const [userId, role] of [
    [owner, "owner"],
    [member, "member"],
    [orgAdmin, "admin"],
  ] as const) {
    await seedOrgMember(bindings.d1, { orgId, userId, role });
    if (userId !== orgAdmin) await seedAppMember(bindings.d1, { appId, userId, role });
  }
  return { appId, otherAppId, environmentId, orgId, owner, member, orgAdmin };
}

export async function makeAuditTinybirdFixture() {
  const bindings = await makeLocalBindings();
  const repo = createRepository(bindings.d1);
  const scope = await seedAuditScope(bindings);
  const principal: Principal = {
    id: scope.owner,
    kind: "control-plane-token",
    scopes: [`app:${scope.appId}:owner`],
    orgId: scope.orgId,
    appId: scope.appId,
    environmentId: null,
    authDoor: "device_flow",
  };
  const oldTime = new Date(Date.now() - 100 * 86_400_000).toISOString();
  const reader = makeAuditTinybirdReader({ bindings, repo, principal, nowIso: () => oldTime });
  const bearer = "CANARY_BEARER_SPL161";
  const targetingKey = "CANARY_TARGETING_KEY_SPL161";
  const context = "CANARY_CONTEXT_SPL161";
  const canaries = [bearer, targetingKey, context];
  return {
    ...bindings,
    ...scope,
    ...reader,
    repo,
    principal,
    canaries,
    events: () => repo.auditEvents.list(appScope(scope.appId)),
    mint: () =>
      reader.app.request(`/apps/${scope.appId}/envs/${scope.environmentId}/api-keys`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bearer}`,
          "x-targeting-key": targetingKey,
          "x-evaluation-context": context,
        },
        body: JSON.stringify({ scopes: ["data-plane:evaluate"] }),
      }),
  };
}

export type AuditTinybirdFixture = Awaited<ReturnType<typeof makeAuditTinybirdFixture>>;
