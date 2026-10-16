import { AppAuditListQuerySchema, canonicalJson } from "@splitch/contracts";
import type { Principal } from "@splitch/worker-runtime";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { readAppAudit } from "./app-audit";
import {
  createTinybirdReadTransport,
  TinybirdReadError,
  type TinybirdReadTransport,
} from "./tinybird";

const changes = {
  environmentId: "env_1",
  organizationId: "org_1",
  targetVersion: "v1",
  outcome: "committed",
  requestId: "req_1",
  approvalRequestId: "apr_1",
  runId: "run_1",
  metadata: { changedFields: ["role"] },
};
const row = {
  audit_id: "event_3",
  dedup_key: "event_3",
  app_id: "app_1",
  user_id: "user_1",
  auth_method: "device_flow",
  action: "api_keys_revoke",
  resource_type: "credential",
  resource_id: "key_1",
  changes: canonicalJson(changes),
  timestamp: "2026-08-03 00:00:00.000",
  archive_version: null,
};
const query = (input = {}) => AppAuditListQuerySchema.parse(input);
const principal: Principal = {
  id: "user_admin",
  kind: "control-plane-token",
  scopes: ["app:app_1:admin"],
  orgId: "org_1",
  appId: "app_1",
  environmentId: null,
  authDoor: "device_flow",
};
function app(readPipe: TinybirdReadTransport["readPipe"], actor = principal) {
  return createApp({
    door: "binding",
    authResolver: () => ({ ok: true, principal: actor }),
    rateLimiter: () => ({ limited: false }),
    tinybird: { readPipe },
    tinybirdDelete: { deleteExposureStatus: async () => {} },
  });
}

describe("App audit read", () => {
  it("uses the real transport with App-only scope and validates its physical response", async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ data: [row] }),
    );
    const transport = createTinybirdReadTransport(
      { TINYBIRD_API_URL: "http://tinybird.test", TINYBIRD_READ_TOKEN: "fixture" },
      { fetchFn },
    );
    const result = await readAppAudit(transport, "app_1", query());
    expect(new URL(String(fetchFn.mock.calls[0]?.[0])).searchParams.get("app_id")).toBe("app_1");
    expect(result.items[0]).toMatchObject({
      eventId: "event_3",
      ...changes,
      actor: { type: "user", userId: "user_1" },
    });
  });

  it("fetches limit+1 and binds the continuation to App, filters and last logical identity", async () => {
    const readPipe = vi
      .fn()
      .mockResolvedValueOnce([row, { ...row, audit_id: "event_2", dedup_key: "event_2" }])
      .mockResolvedValue([]);
    const first = await readAppAudit(
      { readPipe },
      "app_1",
      query({ limit: 1, action: "api_keys_revoke" }),
    );
    expect(first).toMatchObject({ readLimit: 1, readTruncated: true });
    expect(first.items).toHaveLength(1);
    await readAppAudit(
      { readPipe },
      "app_1",
      query({ limit: 1, action: "api_keys_revoke", cursor: first.cursor }),
    );
    expect(readPipe.mock.calls[1]?.[1]).toEqual({
      app_id: "app_1",
      limit: "2",
      action: "api_keys_revoke",
      after_timestamp: "2026-08-03 00:00:00.000",
      after_event_id: "event_3",
    });
    await expect(
      readAppAudit({ readPipe }, "app_other", query({ cursor: first.cursor })),
    ).rejects.toThrow(/cursor/i);
    expect(readPipe).toHaveBeenCalledTimes(2);
  });

  it("maps date filters to Tinybird parameters and accepts nullable safe metadata", async () => {
    const metadata = { resultingTargetVersion: null, errorCode: null };
    const readPipe = vi
      .fn()
      .mockResolvedValue([{ ...row, changes: canonicalJson({ ...changes, metadata }) }]);
    const result = await readAppAudit(
      { readPipe },
      "app_1",
      query({ from: "2026-08-01T01:00:00+01:00", to: "2026-08-04T00:00:00Z" }),
    );
    expect(readPipe).toHaveBeenCalledWith("app_audit_events", {
      app_id: "app_1",
      limit: "51",
      from_timestamp: "2026-08-01 00:00:00.000",
      to_timestamp: "2026-08-04 00:00:00.000",
    });
    expect(result.items[0]?.metadata).toEqual(metadata);
  });

  it.each([null, "unattributed", "deleted-user:user_archived"])(
    "preserves explicit actor attribution %s",
    async (actor) => {
      const result = await readAppAudit(
        { readPipe: async () => [{ ...row, user_id: actor, auth_method: "unattributed" }] },
        "app_1",
        query(),
      );
      expect(result.items[0]?.actor).toEqual(
        actor === null || actor === "unattributed"
          ? { type: "unattributed", userId: null }
          : { type: "user", userId: actor },
      );
    },
  );

  it("denies cross-App delegation before any read", async () => {
    const readPipe = vi.fn();
    const response = await app(readPipe).request("/apps/other/audit");
    expect(response.status).toBe(403);
    expect(readPipe).not.toHaveBeenCalled();
  });

  it.each([
    { app_id: "other" },
    { audit_id: "other" },
    { archive_version: 1 },
    { changes: "not-json" },
    { changes: JSON.stringify(changes) },
    {
      changes: canonicalJson({
        ...changes,
        metadata: {
          rawApiKey: "CANARY_SECRET",
          targetingKey: "CANARY_ENTITY",
          context: { email: "CANARY_EMAIL" },
        },
      }),
    },
    { changes: canonicalJson({ ...changes, before: { keyMaterial: "CANARY_SECRET" } }) },
    { timestamp: "2026-02-30 00:00:00.000" },
    { unknown: "CANARY_SECRET" },
  ])("fails closed on malformed, unsafe or foreign storage data %j", async (patch) => {
    const response = await app(vi.fn().mockResolvedValue([{ ...row, ...patch }])).request(
      "/apps/app_1/audit",
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/CANARY/);
  });

  it("rejects duplicate logical results rather than returning them", async () => {
    const response = await app(vi.fn().mockResolvedValue([row, row])).request("/apps/app_1/audit");
    expect(response.status).toBe(500);
  });

  it("reports provider failures and malformed cursors without inventing empty results", async () => {
    const failure = await app(
      vi.fn().mockRejectedValue(new TinybirdReadError("fixture failure")),
    ).request("/apps/app_1/audit");
    expect(failure.status).toBe(503);
    const readPipe = vi.fn();
    const invalid = await app(readPipe).request("/apps/app_1/audit?cursor=invalid");
    expect(invalid.status).toBe(400);
    expect(readPipe).not.toHaveBeenCalled();
  });
});
