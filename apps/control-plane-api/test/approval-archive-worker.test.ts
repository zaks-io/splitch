import { appScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

    expect(await approvalRowCounts(h.d1, pending)).toEqual({
      requests: 1,
      reviews: 0,
      checkpoints: 0,
    });
    expect(await approvalRowCounts(h.d1, recent)).toEqual({
      requests: 1,
      reviews: 2,
      checkpoints: 0,
    });
    for (const terminal of terminals) {
      expect(await approvalRowCounts(h.d1, terminal.id)).toEqual({
        requests: 0,
        reviews: 0,
        checkpoints: 1,
      });
    }
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
    expect(existing.archive_row_count).toBe(3);
  });

  it.each([
    {
      name: "Tinybird write failure",
      configure(store: MemoryApprovalArchiveStore) {
        store.appendError = new Error("write failed");
      },
      message: "write failed",
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
          archive_row_count: event.archive_row_count + 1,
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
    expect(await approvalRowCounts(h.d1, requestId)).toEqual({
      requests: 1,
      reviews: 2,
      checkpoints: 0,
    });
  });
});
