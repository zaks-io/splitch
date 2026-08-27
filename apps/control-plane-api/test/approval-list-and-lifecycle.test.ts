import { appScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Harness,
  ids,
  makeAuthedApp,
  setProdPolicy,
  token,
} from "../src/config-store-harness-core";
import { MemoryApprovalArchiveStore } from "./approval-archive-test-store";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;

const confirmPolicy = {
  variantAvailability: "confirm",
  targetingRolloutValue: "confirm",
  enabledState: "confirm",
  startExperimentRun: "confirm",
} as const;

beforeEach(async () => {
  h = await makePoolHarness();
  await setProdPolicy(h, confirmPolicy);
  await h.d1.prepare("DELETE FROM runs WHERE app_id = ?").bind(ids.appId).run();
  await h.d1.prepare("DELETE FROM experiments WHERE app_id = ?").bind(ids.appId).run();
});

afterEach(async () => {
  await h.dispose();
});

async function proposeConfigChange(key: string): Promise<string> {
  const jwt = await token(h.signer);
  const response = await h.app.request(
    `/apps/${ids.appId}/envs/${ids.environmentId}/flags/${ids.flagId}/config`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify({ idempotency_key: key, availableVariantNames: ["control"] }),
    },
  );
  const body = (await response.json()) as { code: string; details: { approvalRequestId: string } };
  expect(body.code).toBe("APPROVAL_REVIEW_REQUIRED");
  return body.details.approvalRequestId;
}

async function proposeVariantValue(key: string, value: string): Promise<string> {
  const jwt = await token(h.signer);
  const response = await h.app.request(
    `/apps/${ids.appId}/flags/${ids.flagId}/variants/treatment`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify({ idempotency_key: key, value }),
    },
  );
  const body = (await response.json()) as { code: string; details: { approvalRequestId: string } };
  expect(body.code).toBe("APPROVAL_REVIEW_REQUIRED");
  return body.details.approvalRequestId;
}

async function list(query: string): Promise<{ status: number; body: ListBody }> {
  const jwt = await token(h.signer);
  const response = await h.app.request(`/apps/${ids.appId}/approval-requests${query}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  return { status: response.status, body: (await response.json()) as ListBody };
}

interface ListBody {
  items: Array<{ id: string; status: string }>;
  cursor: string | null;
  limit: number;
  total: number | null;
  readLimit: number;
  readTruncated: boolean;
}

/** Count the per-request projection reads the list handler performs. */
function countProjectionReads(): () => number {
  const flags = h.repo.flags as { getFlagConfig: (...args: never[]) => unknown };
  const original = flags.getFlagConfig.bind(h.repo.flags);
  let calls = 0;
  flags.getFlagConfig = ((...args: never[]) => {
    calls += 1;
    return original(...args);
  }) as typeof flags.getFlagConfig;
  return () => calls;
}

describe("Approval Request list paging", () => {
  it("projects only the page, not every request in the App", async () => {
    for (let i = 0; i < 4; i += 1) await proposeConfigChange(`idem_page_a_${i}`);
    const writeApp = h.app;
    h.app = makeAuthedApp(h, undefined, new MemoryApprovalArchiveStore());
    const small = countProjectionReads();
    const first = await list("?limit=2");
    const readsWithFourRows = small();

    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.cursor).toBe(first.body.items[1]?.id);
    expect(first.body.total).toBeNull();
    expect(first.body.readLimit).toBe(2);
    expect(first.body.readTruncated).toBe(true);

    // Triple the table. The cost of the same page must not move: if the handler
    // materialized every request before slicing, this doubles or worse.
    h.app = writeApp;
    for (let i = 0; i < 8; i += 1) await proposeConfigChange(`idem_page_b_${i}`);
    h.app = makeAuthedApp(h, undefined, new MemoryApprovalArchiveStore());
    const large = countProjectionReads();
    const again = await list("?limit=2");
    expect(again.body.items).toHaveLength(2);
    expect(again.body.total).toBeNull();
    expect(large()).toBe(readsWithFourRows);
  });

  it("walks the whole set through the cursor without repeats or gaps", async () => {
    const proposed = new Set<string>();
    for (let i = 0; i < 5; i += 1) proposed.add(await proposeConfigChange(`idem_walk_${i}`));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : "?limit=2";
      const response: { status: number; body: ListBody } = await list(query);
      seen.push(...response.body.items.map((item) => item.id));
      cursor = response.body.cursor;
      if (!cursor) break;
    }
    expect(new Set(seen)).toEqual(proposed);
    expect(seen).toHaveLength(proposed.size);
  });

  it("rejects an unknown cursor instead of silently restarting", async () => {
    await proposeConfigChange("idem_cursor_bad");
    const response = await list("?limit=2&cursor=apr_does_not_exist");
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "INVALID_PAGINATION" });
  });

  it("filters by Policy-context Environment and leaves unfiltered lists app-scoped", async () => {
    const version = `sha256:${"a".repeat(64)}`;
    const prodId = "apr_01J00000000000000000000001";
    const devId = "apr_01J00000000000000000000002";
    const base = {
      operation: "flag_config_update" as const,
      targetType: "flag_configuration" as const,
      targetVersion: version,
      diff: JSON.stringify({
        current: { enabled: true },
        proposed: { enabled: false },
        entries: [{ path: "/enabled", operation: "replace", current: true, proposed: false }],
      }),
      status: "pending",
      proposedBy: "user_config_admin",
      proposedVia: "id_jag",
      proposedAt: "2026-07-02T12:00:00.000Z",
      resolvedAt: null,
      resultingTargetVersion: null,
      resultingResourceType: null,
      resultingResourceId: null,
      requestHash: version,
    };
    const prod = await h.repo.approvals.createRequest(appScope(ids.appId), {
      ...base,
      id: prodId,
      targetId: ids.configId,
      policyContexts: JSON.stringify([
        { environmentId: ids.environmentId, changeTypes: ["enabled_state"], level: "confirm" },
      ]),
      idempotencyKey: "idem_env_filter_prod",
    });
    const dev = await h.repo.approvals.createRequest(appScope(ids.appId), {
      ...base,
      id: devId,
      targetId: ids.devConfigId,
      proposedAt: "2026-07-02T12:00:01.000Z",
      policyContexts: JSON.stringify([
        {
          environmentId: ids.devEnvironmentId,
          changeTypes: ["enabled_state"],
          level: "confirm",
        },
      ]),
      idempotencyKey: "idem_env_filter_dev",
    });
    expect(prod.ok && !prod.replay).toBe(true);
    expect(dev.ok && !dev.replay).toBe(true);

    const unfiltered = await list("");
    expect(unfiltered.status).toBe(200);
    expect(unfiltered.body.items.map((item) => item.id).sort()).toEqual([devId, prodId].sort());
    expect(unfiltered.body.total).toBe(2);

    const prodOnly = await list(`?environmentId=${ids.environmentId}`);
    expect(prodOnly.status).toBe(200);
    expect(prodOnly.body.items.map((item) => item.id)).toEqual([prodId]);
    expect(prodOnly.body.total).toBe(1);

    const devOnly = await list(`?environmentId=${ids.devEnvironmentId}`);
    expect(devOnly.status).toBe(200);
    expect(devOnly.body.items.map((item) => item.id)).toEqual([devId]);
    expect(devOnly.body.total).toBe(1);

    const foreign = await list("?environmentId=env_other_app");
    expect(foreign.status).toBe(200);
    expect(foreign.body.items).toEqual([]);
    expect(foreign.body.total).toBe(0);
  });
});

describe("an Approval Request whose target no longer resolves", () => {
  it("renders stale rather than reporting NOT_FOUND, and can still be declined", async () => {
    const requestId = await proposeVariantValue("idem_gone", "never-applied");
    await h.repo.flags.removeVariant(appScope(ids.appId), ids.flagId, "treatment");

    const jwt = await token(h.signer);
    const read = await h.app.request(`/apps/${ids.appId}/approval-requests/${requestId}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id: requestId, status: "stale" });

    const listed = await list("?status=stale");
    expect(listed.body.items.map((item) => item.id)).toContain(requestId);

    // Approving must not resurrect a vanished target.
    const approve = await h.app.request(
      `/apps/${ids.appId}/approval-requests/${requestId}/reviews`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
          "idempotency-key": "idem_gone_apply",
        },
        body: JSON.stringify({ action: "approve_and_apply", idempotency_key: "idem_gone_apply" }),
      },
    );
    expect(approve.status).toBe(409);
    expect(await approve.json()).toMatchObject({ code: "APPROVAL_REQUEST_STALE" });
    expect(await h.repo.approvals.getRequest(appScope(ids.appId), requestId)).toMatchObject({
      status: "stale",
    });
  });

  it("declines a request against a vanished target", async () => {
    const requestId = await proposeVariantValue("idem_gone_b", "never-applied-b");
    await h.repo.flags.removeVariant(appScope(ids.appId), ids.flagId, "treatment");

    const jwt = await token(h.signer);
    const declined = await h.app.request(
      `/apps/${ids.appId}/approval-requests/${requestId}/reviews`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
          "idempotency-key": "idem_gone_decline",
        },
        body: JSON.stringify({ action: "decline", idempotency_key: "idem_gone_decline" }),
      },
    );
    expect(declined.status).toBe(200);
    expect(await h.repo.approvals.getRequest(appScope(ids.appId), requestId)).toMatchObject({
      status: "declined",
    });
  });
});
