import { type AppAuditEvent, AppAuditListResponseSchema } from "@splitch/contracts";
import { envScope } from "@splitch/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appendAuditLogRows } from "../src/approval-archive-tinybird";
import { auditLogEvent, forwardAuditEvents } from "../src/audit-events";
import { proveAuditConclusionRead } from "./audit-tinybird-conclusion-proof";
import { proveAuditDeliveryRecovery } from "./audit-tinybird-delivery-proof";
import { type AuditTinybirdFixture, makeAuditTinybirdFixture } from "./audit-tinybird-fixture";

let h: AuditTinybirdFixture;
beforeAll(async () => {
  h = await makeAuditTinybirdFixture();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await h?.dispose();
});

describe("real D1 to Tinybird to authorized route audit boundary", () => {
  it("recovers loss and cron failure, deduplicates before pagination, and refuses unauthorized reads", async () => {
    const { rows, payloads } = await proveAuditDeliveryRecovery(h);

    const items: AppAuditEvent[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "1", ...(cursor ? { cursor } : {}) });
      const response = await h.app.request(`/apps/${h.appId}/audit?${query}`);
      expect(response.status).toBe(200);
      const page = AppAuditListResponseSchema.parse(await response.json());
      items.push(...page.items);
      cursor = page.cursor;
      expect(items.length).toBeLessThanOrEqual(3);
    } while (cursor);
    expect(items).toHaveLength(3);
    expect(new Set(items.map((event) => event.eventId)).size).toBe(3);
    expect(
      items.every((event) => event.actor.type === "user" && event.actor.userId === h.owner),
    ).toBe(true);
    for (const canary of h.canaries) {
      expect(JSON.stringify({ outbox: rows, payloads, items })).not.toContain(canary);
    }

    const sql = new URL("/v0/sql", h.apiUrl);
    sql.searchParams.set(
      "q",
      `SELECT count() AS physical, uniqExact(audit_id) AS logical FROM audit_log WHERE app_id = '${h.appId}' FORMAT JSON`,
    );
    const raw = await h.network(sql, { headers: { authorization: `Bearer ${h.token}` } });
    expect(raw.status).toBe(200);
    const physical = (await raw.json()) as { data: Array<{ physical: number; logical: number }> };
    expect(Number(physical.data[0]?.physical)).toBe(5);
    expect(Number(physical.data[0]?.logical)).toBe(3);

    const before = h.readCalls.length;
    for (const principal of [
      { ...h.principal, appId: h.otherAppId, scopes: [`app:${h.otherAppId}:owner`] },
      { ...h.principal, id: h.member, scopes: [`app:${h.appId}:owner`] },
      { ...h.principal, id: h.orgAdmin, appId: null, scopes: [`org:${h.orgId}:admin`] },
    ]) {
      h.become(principal);
      expect((await h.app.request(`/apps/${h.appId}/audit`)).status).toBe(403);
    }
    expect(h.readCalls).toHaveLength(before);
    h.become(h.principal);
    const missingScope = await h.network(
      new URL("/v0/pipes/app_audit_events.json?limit=2", h.apiUrl),
      {
        headers: { authorization: `Bearer ${h.token}` },
      },
    );
    expect(missingScope.status).toBe(400);
  });

  it("reads live actors, carried deleted-user tombstones and explicit unattributed actors together", async () => {
    const changedAt = new Date().toISOString();
    for (const [keyId, actorRef] of [
      ["live_actor_key", h.owner],
      ["tombstone_key", "deleted-user:user_archived"],
      ["unknown_key", null],
    ] as const) {
      await h.repo.credentials.createApiKey(
        envScope(h.appId, h.environmentId),
        {
          keyId,
          appId: h.appId,
          environmentId: h.environmentId,
          keyHash: `test_hash_${keyId}`,
          scopes: '["data-plane:evaluate"]',
          createdAt: changedAt,
        },
        {
          actorRef,
          actorVia: actorRef ? "device_flow" : null,
          requestId: null,
          changedAt,
        },
      );
    }
    expect(await forwardAuditEvents({ repo: h.repo, env: h.env })).toBe(3);
    const response = await h.app.request(
      `/apps/${h.appId}/audit?${new URLSearchParams({ from: changedAt, limit: "100" })}`,
    );
    expect(response.status).toBe(200);
    const page = AppAuditListResponseSchema.parse(await response.json());
    expect(page.items).toHaveLength(3);
    for (const [keyId, actor] of [
      ["live_actor_key", { type: "user", userId: h.owner }],
      ["tombstone_key", { type: "user", userId: "deleted-user:user_archived" }],
      ["unknown_key", { type: "unattributed", userId: null }],
    ] as const) {
      expect(page.items.find((event) => event.resourceId === keyId)?.actor).toEqual(actor);
    }
  });

  it(
    "excludes existing and rotated Client Key material across real delivery and read",
    proveClientKeyPrivacy,
  );

  it(
    "correlates committed Approval Request, Review, Configuration and Run through one real read",
    proveAuditConclusionRead,
  );

  it("fails loudly on conflicting canonical content even when filters exclude that identity", async () => {
    const row = (await h.events())[0];
    if (!row) throw new Error("Expected an existing canonical audit event");
    await appendAuditLogRows(h.env, [
      { ...auditLogEvent(row), resource_id: "conflicting_resource" },
    ]);
    // Tinybird includes a dynamic query id in this error, which YAML's exact matcher cannot assert.
    for (const filter of [{}, { action: "no_matching_action" }, { resource_id: "absent" }]) {
      const endpoint = new URL("/v0/pipes/app_audit_events.json", h.apiUrl);
      endpoint.search = new URLSearchParams({ app_id: h.appId, limit: "2", ...filter }).toString();
      const rejected = await h.network(endpoint, {
        headers: { authorization: `Bearer ${h.token}` },
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).toContain("Conflicting App audit event identity");
    }
    const response = await h.app.request(`/apps/${h.appId}/audit?action=no_matching_action`);
    expect(response.status).toBe(503);
  });
});

async function proveClientKeyPrivacy() {
  const material = "pk_CANARY_CLIENT_MATERIAL_SPL161";
  h.canaries.push(material);
  await h.repo.credentials.clientKeys.insert(envScope(h.appId, h.environmentId), {
    keyId: "ck_client_canary",
    appId: h.appId,
    environmentId: h.environmentId,
    keyMaterial: material,
    originAllowlist: null,
    rateLimitRps: 50,
    createdAt: new Date().toISOString(),
  });
  const rotated = await h.app.request(
    `/apps/${h.appId}/envs/${h.environmentId}/client-key/revoke`,
    { method: "POST", headers: { authorization: `Bearer ${h.canaries[0]}` } },
  );
  expect(rotated.status).toBe(200);
  const body = (await rotated.json()) as { newKey: { keyId: string; keyMaterial: string } };
  h.canaries.push(body.newKey.keyMaterial);
  const payloads: string[] = [];
  expect(
    await forwardAuditEvents({
      repo: h.repo,
      env: h.env,
      fetchFn: async (request, init) => {
        payloads.push(String(init?.body));
        return h.network(request, init);
      },
    }),
  ).toBe(1);
  const response = await h.app.request(
    `/apps/${h.appId}/audit?resourceId=${encodeURIComponent(body.newKey.keyId)}`,
  );
  expect(response.status).toBe(200);
  const page = AppAuditListResponseSchema.parse(await response.json());
  expect(page.items).toHaveLength(1);
  expect(page.items[0]?.action).toBe("client_key_rotate");
  const recorded = JSON.stringify({ outbox: await h.events(), payloads, page });
  for (const canary of h.canaries) expect(recorded).not.toContain(canary);
}
