import { appScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalArchiveEvent, runApprovalRequestArchival } from "../src/approval-archive";
import { type Harness, ids } from "../src/config-store-harness-core";
import { approvalRowCounts, seedApprovalArchiveFixture } from "./approval-archive-fixture";
import { MemoryApprovalArchiveStore } from "./approval-archive-test-store";
import { makePoolHarness } from "./config-store-pool-harness";

const NOW = new Date("2026-08-07T12:00:00.000Z");
const OLD = "2026-05-01T12:00:00.000Z";
const RECENT = "2026-05-10T12:00:00.000Z";

let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
});

afterEach(async () => {
  await h.dispose();
});

describe("Approval Request terminal archival", () => {
  it("archives only materially terminal Requests older than 90 days", async () => {
    const pending = "apr_01J00000000000000000000101";
    const recent = "apr_01J00000000000000000000102";
    const terminals = [
      { id: "apr_01J00000000000000000000103", status: "applied" as const },
      { id: "apr_01J00000000000000000000106", status: "declined" as const },
      { id: "apr_01J00000000000000000000107", status: "stale" as const },
    ];
    await seedApprovalArchiveFixture(h.d1, { id: pending, status: "pending", proposedAt: OLD });
    await seedApprovalArchiveFixture(h.d1, { id: recent, resolvedAt: RECENT });
    for (const terminal of terminals) {
      await seedApprovalArchiveFixture(h.d1, { ...terminal, resolvedAt: OLD });
    }
    const store = new MemoryApprovalArchiveStore();

    await expect(runApprovalRequestArchival({ repo: h.repo, store, now: NOW })).resolves.toBe(3);

    expect(await approvalRowCounts(h.d1, ids.appId, pending)).toEqual({
      requests: 1,
      reviews: 0,
    });
    expect(await approvalRowCounts(h.d1, ids.appId, recent)).toEqual({
      requests: 1,
      reviews: 2,
    });
    for (const terminal of terminals) {
      expect(await approvalRowCounts(h.d1, ids.appId, terminal.id)).toEqual({
        requests: 0,
        reviews: 0,
      });
    }
  });

  it("does not expose an append before its acknowledgment", async () => {
    const requestId = "apr_01J00000000000000000000108";
    await seedApprovalArchiveFixture(h.d1, { id: requestId, resolvedAt: OLD });
    const store = new MemoryApprovalArchiveStore();
    let acknowledge: (() => void) | undefined;
    store.acknowledgeAppend = () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      });

    const sweep = runApprovalRequestArchival({ repo: h.repo, store, now: NOW });
    await vi.waitFor(() => expect(store.pendingEvents.size).toBe(1));

    expect(await store.get(ids.appId, requestId, 1)).toBeNull();
    expect(await approvalRowCounts(h.d1, ids.appId, requestId)).toEqual({
      requests: 1,
      reviews: 2,
    });
    if (!acknowledge) throw new Error("append acknowledgment was not requested");
    acknowledge();

    await expect(sweep).resolves.toBe(1);
    expect(await store.get(ids.appId, requestId, 1)).not.toBeNull();
    expect(await approvalRowCounts(h.d1, ids.appId, requestId)).toEqual({
      requests: 0,
      reviews: 0,
    });
  });

  it("preserves complete rows and replays an existing archive idempotently", async () => {
    const requestId = "apr_01J00000000000000000000104";
    const largeText = "untruncated:".repeat(2_000);
    await seedApprovalArchiveFixture(h.d1, { id: requestId, resolvedAt: OLD, largeText });
    const request = await h.repo.approvals.getRequest(appScope(ids.appId), requestId);
    if (!request) throw new Error("fixture request missing");
    const reviews = await h.repo.approvals.listReviews(appScope(ids.appId), requestId);
    const existing = await approvalArchiveEvent(request, reviews, NOW.toISOString());
    const store = new MemoryApprovalArchiveStore();
    store.events.set(existing.dedup_key, existing);

    await expect(runApprovalRequestArchival({ repo: h.repo, store, now: NOW })).resolves.toBe(1);
    await expect(runApprovalRequestArchival({ repo: h.repo, store, now: NOW })).resolves.toBe(0);

    expect(store.appendCalls).toBe(0);
    const payload = JSON.parse(existing.changes) as {
      request: { diff: string };
      reviews: Array<{ reason: string; errorDetails: string | null }>;
    };
    expect(payload.request.diff).toContain(largeText);
    expect(payload.reviews).toHaveLength(2);
    expect(payload.reviews[0]?.reason).toBe(largeText);
    expect(payload.reviews[0]?.errorDetails).toContain(largeText);
    expect(existing.archived_d1_row_count).toBe(3);
  });
});

describe("Approval Request archival sweep isolation", () => {
  it("drains healthy candidates before failing loudly with every poison detail", async () => {
    const poisons = ["apr_01J00000000000000000000109", "apr_01J00000000000000000000110"];
    const healthy = ["apr_01J00000000000000000000111"];
    for (const id of [...poisons, ...healthy]) {
      await seedApprovalArchiveFixture(h.d1, { id, resolvedAt: OLD });
    }
    const store = new MemoryApprovalArchiveStore();
    store.acknowledgeAppend = async (event) => {
      if (poisons.includes(event.resource_id)) {
        throw new Error(`Tinybird quarantined the complete payload for ${event.resource_id}`);
      }
    };

    const sweep = runApprovalRequestArchival({ repo: h.repo, store, now: NOW });
    for (const poison of poisons) {
      await expect(sweep).rejects.toThrow(poison);
      await expect(sweep).rejects.toThrow(
        `Tinybird quarantined the complete payload for ${poison}`,
      );
    }

    for (const poison of poisons) {
      expect(await approvalRowCounts(h.d1, ids.appId, poison)).toEqual({
        requests: 1,
        reviews: 2,
      });
    }
    for (const id of healthy) {
      expect(await approvalRowCounts(h.d1, ids.appId, id)).toEqual({
        requests: 0,
        reviews: 0,
      });
    }
    expect(store.events.size).toBe(healthy.length);
  });

  it("keeps every D1 row when a Review appears before finalization", async () => {
    const requestId = "apr_01J00000000000000000000114";
    await seedApprovalArchiveFixture(h.d1, { id: requestId, resolvedAt: OLD });
    const reviews = await h.repo.approvals.listReviews(appScope(ids.appId), requestId);
    await h.d1
      .prepare(
        `INSERT INTO approval_reviews (
          id, app_id, approval_request_id, action, outcome, reviewed_by,
          reviewed_via, reviewed_at, reason, idempotency_key, request_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "rev_01J00000000000000000000114C",
        ids.appId,
        requestId,
        "decline",
        "declined",
        "user_archive_race",
        "id_jag",
        "2026-05-01T12:00:01.000Z",
        "inserted during archival",
        "idem_archive_race",
        `sha256:${"e".repeat(64)}`,
      )
      .run();

    await expect(
      h.repo.approvals.finalizeArchive(
        appScope(ids.appId),
        { requestId, resolvedAt: OLD, reviewCount: reviews.length },
        "declined",
      ),
    ).rejects.toThrow("archive finalization failed");
    expect(await approvalRowCounts(h.d1, ids.appId, requestId)).toEqual({
      requests: 1,
      reviews: 3,
    });
  });
});

describe("Approval Request archive verification failures", () => {
  it.each([
    {
      name: "Tinybird write failure",
      configure(store: MemoryApprovalArchiveStore) {
        store.appendError = new Error("write failed");
      },
      message: "write failed",
    },
    {
      name: "archive event App-scope mismatch",
      configure(store: MemoryApprovalArchiveStore) {
        store.mutateRead = (event) => ({ ...event, app_id: ids.otherAppId });
      },
      message: "Approval Request archive crossed its App scope",
    },
    {
      name: "archive-version mismatch",
      configure(store: MemoryApprovalArchiveStore) {
        store.mutateRead = (event) => {
          const payload = JSON.parse(event.changes) as { archiveVersion: number };
          payload.archiveVersion = 2;
          return { ...event, changes: JSON.stringify(payload) };
        };
      },
      message: "archive version mismatch",
    },
    {
      name: "checksum mismatch",
      configure(store: MemoryApprovalArchiveStore) {
        store.mutateRead = (event) => ({ ...event, archive_checksum: `sha256:${"0".repeat(64)}` });
      },
      message: "checksum mismatch",
    },
    {
      name: "row-count mismatch",
      configure(store: MemoryApprovalArchiveStore) {
        store.mutateRead = (event) => ({
          ...event,
          archived_d1_row_count: event.archived_d1_row_count + 1,
        });
      },
      message: "row-count mismatch",
    },
  ])("leaves D1 unchanged on $name", async ({ configure, message }) => {
    const requestId = "apr_01J00000000000000000000105";
    await seedApprovalArchiveFixture(h.d1, { id: requestId, resolvedAt: OLD });
    const store = new MemoryApprovalArchiveStore();
    configure(store);

    await expect(runApprovalRequestArchival({ repo: h.repo, store, now: NOW })).rejects.toThrow(
      message,
    );
    expect(await approvalRowCounts(h.d1, ids.appId, requestId)).toEqual({
      requests: 1,
      reviews: 2,
    });
  });
});
