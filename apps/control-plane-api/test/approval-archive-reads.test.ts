import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runApprovalRequestArchival } from "../src/approval-archive";
import { type Harness, ids, makeAuthedApp, token } from "../src/config-store-harness-core";
import { seedApprovalArchiveFixture } from "./approval-archive-fixture";
import { MemoryApprovalArchiveStore } from "./approval-archive-test-store";
import { makePoolHarness } from "./config-store-pool-harness";

const NOW = new Date("2026-08-07T12:00:00.000Z");
const OLD = "2026-05-01T12:00:00.000Z";
let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
});

afterEach(async () => {
  await h.dispose();
});

describe("Approval Request archived reads", () => {
  it("returns the identical wire projection before and after archival", async () => {
    const requestId = "apr_01J00000000000000000000201";
    await seedApprovalArchiveFixture(h.d1, { id: requestId, resolvedAt: OLD });
    const before = await getRequest(h, requestId);
    const store = new MemoryApprovalArchiveStore();

    await runApprovalRequestArchival({ repo: h.repo, store, now: NOW });
    h.app = makeAuthedApp(h, undefined, store);
    const after = await getRequest(h, requestId);

    expect(after.status).toBe(200);
    expect(after.body).toEqual(before.body);
    expect(after.body).toMatchObject({
      id: requestId,
      status: "declined",
      latestReview: {
        actor: { userId: "deleted-user:user_archived" },
        reason: "complete-value",
      },
    });
  });

  it("walks the D1-to-Tinybird boundary without duplicates or gaps", async () => {
    const idsByAge = [
      "apr_01J00000000000000000000202",
      "apr_01J00000000000000000000203",
      "apr_01J00000000000000000000204",
    ] as const;
    await seedApprovalArchiveFixture(h.d1, {
      id: idsByAge[0],
      proposedAt: "2026-06-01T00:00:00.000Z",
      resolvedAt: "2026-06-02T00:00:00.000Z",
    });
    await seedApprovalArchiveFixture(h.d1, {
      id: idsByAge[1],
      proposedAt: "2026-04-02T00:00:00.000Z",
      resolvedAt: OLD,
    });
    await seedApprovalArchiveFixture(h.d1, {
      id: idsByAge[2],
      proposedAt: "2026-04-01T00:00:00.000Z",
      resolvedAt: OLD,
    });
    const store = new MemoryApprovalArchiveStore();
    await runApprovalRequestArchival({ repo: h.repo, store, now: NOW });
    h.app = makeAuthedApp(h, undefined, store);

    const first = await listRequests(h, "?limit=2");
    expect(first.items.map((item) => item.id)).toEqual(idsByAge.slice(0, 2));
    expect(first.cursor).toBe(idsByAge[1]);
    const second = await listRequests(h, `?limit=2&cursor=${first.cursor}`);
    expect(second.items.map((item) => item.id)).toEqual([idsByAge[2]]);
    expect(second.cursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id))).toEqual(
      new Set(idsByAge),
    );
  });

  it("rejects a cross-App read before consulting the archive store", async () => {
    const requestId = "apr_01J00000000000000000000205";
    const store = new MemoryApprovalArchiveStore();
    h.app = makeAuthedApp(h, undefined, store);
    const jwt = await token(h.signer);

    const response = await h.app.request(`/apps/${ids.otherAppId}/approval-requests/${requestId}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(response.status).toBe(403);
    expect(store.getCalls).toBe(0);
  });
});

async function getRequest(
  harness: Harness,
  requestId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const jwt = await token(harness.signer);
  const response = await harness.app.request(`/apps/${ids.appId}/approval-requests/${requestId}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function listRequests(
  harness: Harness,
  query: string,
): Promise<{
  items: Array<{ id: string }>;
  cursor: string | null;
}> {
  const jwt = await token(harness.signer);
  const response = await harness.app.request(`/apps/${ids.appId}/approval-requests${query}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  expect(response.status).toBe(200);
  return response.json();
}
