import {
  type PersonalAccessTokenPermission,
  personalAccessTokenAuthority,
  type UserRole,
} from "@splitch/contracts";
import { appScope, envScope } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type Harness,
  ids,
  promoteFlagConfig,
  setProdPolicy,
  USER_ID,
} from "../src/config-store-harness-core";
import { configStoreAccess } from "../src/experiment-run-test-fixture";
import { makeTestApp } from "../src/test-app-fixture";
import {
  clearFrozenRun,
  confirmPolicy,
  countApprovalReviews,
  deleteFlagRequest,
  deleteVariantRequest,
  reviewRequest,
} from "./approval-harness";
import { makePoolHarness } from "./config-store-pool-harness";

let h: Harness;
let principal: Principal;

beforeEach(async () => {
  h = await makePoolHarness();
  await setProdPolicy(h, confirmPolicy);
  await clearFrozenRun(h);
  await h.d1.prepare("DELETE FROM targeting_rules WHERE app_id = ?").bind(ids.appId).run();
  principal = {
    kind: "control-plane-token",
    id: USER_ID,
    scopes: [`app:${ids.appId}:owner`],
    orgId: null,
    appId: ids.appId,
    environmentId: null,
    authDoor: "device_flow",
  };
  h.app = makeTestApp({
    repo: h.repo,
    authResolver: () => ({ ok: true, principal }),
    configStore: configStoreAccess(h.repo, h.kv),
  });
});

function usePat(permissions: PersonalAccessTokenPermission[], role: UserRole = "owner") {
  const authority = personalAccessTokenAuthority(
    { organizations: [], apps: [{ id: ids.appId, organizationId: ids.orgId, role: "owner" }] },
    [
      { target: `app:${ids.appId}`, role, permissions },
      { target: `app:${ids.appId}`, role: "owner", permissions: [] },
    ],
  );
  principal = {
    ...principal,
    authDoor: "personal_access_token",
    scopes: authority.scopes,
    personalAccessToken: { id: "pat_approval", permissions: authority.permissions },
  };
}

describe("PAT authority at stored Approval application", () => {
  it.each(["flag", "variant"] as const)(
    "refuses a session-created %s deletion without delete, then applies with delete",
    async (kind) => {
      const proposed =
        kind === "flag"
          ? await deleteFlagRequest(h, `pat_propose_${kind}`)
          : await deleteVariantRequest(h, "treatment", `pat_propose_${kind}`);
      expect(proposed.status).toBe(409);
      const id = proposed.approvalRequestId as string;
      expect(await h.repo.approvals.getRequest(appScope(ids.appId), id)).toMatchObject({
        proposedVia: "device_flow",
        status: "pending",
      });
      const before = await h.d1
        .prepare("SELECT * FROM flags WHERE app_id = ?")
        .bind(ids.appId)
        .all<{ id: string }>();
      const variants = await h.repo.flags.listVariants(appScope(ids.appId), ids.flagId);
      usePat(["write"]);
      const refused = await reviewRequest(h, id, `pat_refuse_${kind}`);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("delete"),
      });
      expect(await countApprovalReviews(h)).toBe(0);
      expect(
        (await h.d1.prepare("SELECT * FROM flags WHERE app_id = ?").bind(ids.appId).all()).results,
      ).toEqual(before.results);
      expect(await h.repo.flags.listVariants(appScope(ids.appId), ids.flagId)).toEqual(variants);

      usePat(["write", "delete"]);
      const applied = await reviewRequest(h, id, `pat_apply_${kind}`);
      expect(applied.status, await applied.clone().text()).toBe(200);
      expect(await applied.json()).toMatchObject({ status: "applied" });
      if (kind === "flag")
        expect(await h.repo.flags.getFlag(appScope(ids.appId), ids.flagId)).toBeNull();
      else
        expect(
          await h.repo.flags.getVariantById(appScope(ids.appId), ids.treatmentVariantId),
        ).toBeNull();
    },
  );

  it("requires the stored operation's role even if a read grant carries owner", async () => {
    const proposed = await deleteFlagRequest(h, "pat_role_propose");
    usePat(["delete"], "member");
    const response = await reviewRequest(
      h,
      proposed.approvalRequestId as string,
      "pat_role_refuse",
    );
    expect(response.status).toBe(403);
    expect(await countApprovalReviews(h)).toBe(0);
  });

  it("requires write to decline and leaves a refused proposal pending", async () => {
    const proposed = await deleteFlagRequest(h, "pat_decline_propose");
    const id = proposed.approvalRequestId as string;
    usePat(["delete"]);
    const refused = await reviewRequest(h, id, "pat_decline_refuse", "decline");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("write"),
    });
    expect(await countApprovalReviews(h)).toBe(0);
    usePat(["write"]);
    expect((await reviewRequest(h, id, "pat_decline_apply", "decline")).status).toBe(200);
    expect(await h.repo.flags.getFlag(appScope(ids.appId), ids.flagId)).not.toBeNull();
  });

  it("approves and applies a Promotion with write alone", async () => {
    const proposed = await promoteFlagConfig(h, {
      fromEnvironmentId: ids.devEnvironmentId,
      select: { enabled: true },
    });
    expect(proposed.status, await proposed.clone().text()).toBe(409);
    const body = (await proposed.json()) as { details: { approvalRequestId: string } };
    usePat(["write"], "admin");
    const applied = await reviewRequest(h, body.details.approvalRequestId, "pat_promote_apply");
    expect(applied.status, await applied.clone().text()).toBe(200);
    expect(
      await h.repo.flags.getFlagConfig(envScope(ids.appId, ids.environmentId), ids.flagId),
    ).toMatchObject({ enabled: true });
  });
});
