import { appScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ApprovalArchiveStore, approvalArchiveEvent } from "../src/approval-archive";
import { type Harness, ids, makeAuthedApp, token } from "../src/config-store-harness-core";
import { seedApprovalArchiveFixture } from "./approval-archive-fixture";
import { makePoolHarness } from "./config-store-pool-harness";

const FOREIGN_REQUEST_ID = "apr_01J00000000000000000000212";
let h: Harness;
let headers: { authorization: string };

beforeEach(async () => {
  h = await makePoolHarness();
  await seedApprovalArchiveFixture(h.d1, {
    id: FOREIGN_REQUEST_ID,
    appId: ids.otherAppId,
    environmentId: "env_archive_scope_other",
    targetId: "flag_config_archive_scope_other",
    targetVersion: `sha256:${"d".repeat(64)}`,
    proposedBy: "user_archive_scope_other",
    reviewedBy: "deleted-user:user_archive_scope_other",
  });
  const request = await h.repo.approvals.getRequest(appScope(ids.otherAppId), FOREIGN_REQUEST_ID);
  if (!request) throw new Error("foreign Approval Request fixture is missing");
  const reviews = await h.repo.approvals.listReviews(appScope(ids.otherAppId), FOREIGN_REQUEST_ID);
  const event = await approvalArchiveEvent(request, reviews, "2026-08-07T12:00:00.000Z");
  const leakingStore: ApprovalArchiveStore = {
    append: () => Promise.resolve(),
    get: () => Promise.resolve(event),
    list: () => Promise.resolve([event]),
  };
  h.app = makeAuthedApp(h, undefined, leakingStore);
  headers = { authorization: `Bearer ${await token(h.signer)}` };
});

afterEach(async () => {
  await h.dispose();
});

describe("Approval Request archived read App scope", () => {
  it("fails loud when a regressed archive get leaks another App", async () => {
    const getResponse = await h.app.request(
      `/apps/${ids.appId}/approval-requests/${FOREIGN_REQUEST_ID}`,
      { headers },
    );
    await expectNoLeak(getResponse);
  });

  it("fails loud when a regressed archive list leaks another App", async () => {
    const listResponse = await h.app.request(`/apps/${ids.appId}/approval-requests`, { headers });
    await expectNoLeak(listResponse);
  });
});

async function expectNoLeak(response: Response): Promise<void> {
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain(FOREIGN_REQUEST_ID);
}
