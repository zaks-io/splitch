import type { AuthResolver, Principal, RateLimiter } from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { PipeParams, TinybirdReadTransport } from "./tinybird";

const PATH = "/internal/apps/app_privacy/entity-analysis/export";
const allowLimiter: RateLimiter = () => ({ limited: false });

const rows = [
  row("deduped_exposures", "record-1"),
  row("metric_events", "record-2"),
  row("metric_events", "record-3"),
  row("raw_events", "record-4"),
  row("raw_events", "record-5"),
];

describe("Entity analysis privacy export pages", () => {
  it("returns first, middle, and final pages in stable keyset order", async () => {
    const calls: PipeParams[] = [];
    const app = privacyApp(pagedTinybird(calls));
    const pages: Array<{ records: typeof rows; nextCursor: string | null }> = [];
    let cursor: string | null = null;
    do {
      const response = await exportRequest(app, { limit: 2, cursor });
      expect(response.status).toBe(200);
      const page = (await response.json()) as (typeof pages)[number];
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(pages).toHaveLength(3);
    expect(pages.map((page) => page.records.map((record) => record.record_id))).toEqual([
      ["record-1", "record-2"],
      ["record-3", "record-4"],
      ["record-5"],
    ]);
    expect(calls).toHaveLength(3);
    expect(calls[0]).not.toHaveProperty("after_store");
    expect(calls[1]).toMatchObject({
      after_store: "metric_events",
      after_record_id: "record-2",
      limit: "2",
    });
    expect(calls[2]).toMatchObject({
      after_store: "raw_events",
      after_record_id: "record-4",
      limit: "2",
    });
    const ids = pages.flatMap((page) => page.records.map((record) => record.record_id));
    expect(new Set(ids).size).toBe(rows.length);
  });

  it("rejects invalid limits and a cursor from another Entity scope", async () => {
    const app = privacyApp(pagedTinybird([]));
    for (const limit of [0, 101, 1.5]) {
      const response = await exportRequest(app, { limit, cursor: null });
      expect(response.status).toBe(400);
    }

    const first = await exportRequest(app, { limit: 1, cursor: null });
    const cursor = ((await first.json()) as { nextCursor: string }).nextCursor;
    const wrongScope = await exportRequest(app, {
      limit: 1,
      cursor,
      entityFamilyHash: "app-v1:other-family",
    });
    expect(wrongScope.status).toBe(403);
  });
});

function privacyApp(tinybird: TinybirdReadTransport) {
  const authResolver: AuthResolver = () => ({ ok: true, principal: principal() });
  return createApp({
    door: "binding",
    authResolver,
    rateLimiter: allowLimiter,
    tinybird,
    tinybirdDelete: { deleteExposureStatus: async () => {} },
    platformTarget: "local",
  });
}

function pagedTinybird(calls: PipeParams[]): TinybirdReadTransport {
  return {
    async readPipe(_pipeName, params) {
      calls.push({ ...params });
      const after = params.after_record_id;
      const start =
        after === undefined ? 0 : rows.findIndex((entry) => entry.record_id === after) + 1;
      const limit = Number(params.limit);
      const page = rows.slice(start, start + limit);
      return page.map((entry) => ({ ...entry, has_more: start + page.length < rows.length }));
    },
  };
}

function exportRequest(
  app: ReturnType<typeof privacyApp>,
  page: { limit: number; cursor: string | null; entityFamilyHash?: string },
) {
  return app.request(PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idType: "user",
      targetingKeyHashes: ["app-v1:entity-hash"],
      entityFamilyHash: page.entityFamilyHash ?? "app-v1:family-hash",
      limit: page.limit,
      cursor: page.cursor,
    }),
  });
}

function row(store: string, recordId: string) {
  return {
    store,
    record_id: recordId,
    targeting_key_hash: "app-v1:entity-hash",
    entity_family_hash: "app-v1:family-hash",
    server_received_at: `2026-08-07 00:00:0${recordId.at(-1)}.000`,
    record: JSON.stringify({ event_id: recordId }),
    record_hash: `hash-${recordId}`,
    has_more: false,
  };
}

function principal(): Principal {
  return {
    kind: "control-plane-token",
    id: "control-plane-api",
    scopes: [],
    orgId: "org_privacy",
    appId: "app_privacy",
    environmentId: null,
    authDoor: null,
  };
}
