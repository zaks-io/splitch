import type { PersonalAccessTokenGrant } from "@splitch/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP,
  OTHER_APP,
  readGrant,
  ORG as SESSION_ORG,
  stepUpFixture,
  USER,
} from "./personal-access-token-step-up-fixture";

let f: Awaited<ReturnType<typeof stepUpFixture>>;
beforeEach(async () => {
  f = await stepUpFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.bindings.dispose();
});

const ORG = "org_step_up_other";
const losses = [
  "Org demoted",
  "App demoted",
  "both demoted",
  "Org removed",
  "App removed",
  "both removed",
] as const;
const changes = ["retained", "permissions narrowed", "role narrowed", "dropped"] as const;
const helper: PersonalAccessTokenGrant = {
  ...readGrant,
  role: "owner",
  permissions: ["write", "delete"],
};

async function loseMembership(loss: (typeof losses)[number]) {
  const mutation = loss.endsWith("removed") ? "DELETE FROM" : "UPDATE";
  const assignment = loss.endsWith("removed") ? "" : " SET role = 'member'";
  if (!loss.startsWith("App")) {
    await f.bindings.d1
      .prepare(`${mutation} org_memberships${assignment} WHERE org_id = ? AND user_id = ?`)
      .bind(ORG, USER)
      .run();
  }
  if (!loss.startsWith("Org")) {
    await f.bindings.d1
      .prepare(`${mutation} app_memberships${assignment} WHERE app_id = ? AND user_id = ?`)
      .bind(OTHER_APP, USER)
      .run();
  }
}

describe("cleanup after losing membership through real D1 routes", () => {
  it.each(
    losses.flatMap((loss) =>
      (["Org", "App"] as const).flatMap((target) =>
        changes.map((change) => ({ loss, target, change })),
      ),
    ),
  )("allows $target $change with $loss without approval", async ({ loss, target, change }) => {
    const stored: PersonalAccessTokenGrant = {
      target: target === "Org" ? `org:${ORG}` : `app:${OTHER_APP}`,
      role: "owner",
      permissions: ["write", "delete"],
    };
    const { row } = await f.seed([stored, helper]);
    await loseMembership(loss);
    const outcomes: Record<(typeof changes)[number], PersonalAccessTokenGrant[]> = {
      dropped: [helper],
      retained: [stored, readGrant],
      "permissions narrowed": [{ ...stored, permissions: ["write"] }, helper],
      "role narrowed": [{ ...stored, role: "member" }, helper],
    };
    const grants = outcomes[change];
    const response = await f.call("PATCH", `/personal-access-tokens/${row.id}`, { grants });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await f.repo.personalAccessTokens.getForUser(USER, row.id)).toMatchObject({
      grants: JSON.stringify(grants),
      tokenHash: row.tokenHash,
      expiresAt: null,
    });
    expect(f.puts).toEqual([]);
  });

  it.each(losses)(
    "narrows Org to its existing App with %s using canonical D1 identity",
    async (loss) => {
      const { row } = await f.seed([
        { target: `org:${ORG}`, role: "owner", permissions: ["write"] },
      ]);
      await loseMembership(loss);
      const lookup = vi.spyOn(f.repo.identity, "getApp");
      const grants = [{ ...readGrant, target: `app:${OTHER_APP}` }];
      const response = await f.call("PATCH", `/personal-access-tokens/${row.id}`, { grants });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(lookup.mock.calls).toEqual([[OTHER_APP]]);
      expect(await f.repo.personalAccessTokens.getForUser(USER, row.id)).toMatchObject({
        grants: JSON.stringify(grants),
        tokenHash: row.tokenHash,
      });
      expect(f.puts).toEqual([]);
    },
  );

  it.each(losses.flatMap((loss) => changes.map((change) => ({ loss, change }))))(
    "narrows an Org while an App is $change with $loss",
    async ({ loss, change }) => {
      const stored: PersonalAccessTokenGrant = {
        target: `app:${OTHER_APP}`,
        role: "owner",
        permissions: ["write", "delete"],
      };
      const { row } = await f.seed([
        { target: `org:${SESSION_ORG}`, role: "owner", permissions: ["write"] },
        stored,
      ]);
      await loseMembership(loss);
      const outcomes: Record<(typeof changes)[number], PersonalAccessTokenGrant[]> = {
        retained: [stored],
        "permissions narrowed": [{ ...stored, permissions: ["write"] }],
        "role narrowed": [{ ...stored, role: "member" }],
        dropped: [],
      };
      const lookup = vi.spyOn(f.repo.identity, "getApp");
      const grants = [readGrant, ...outcomes[change]];
      const response = await f.call("PATCH", `/personal-access-tokens/${row.id}`, { grants });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(lookup.mock.calls).toEqual([[APP]]);
      expect(await f.repo.personalAccessTokens.getForUser(USER, row.id)).toMatchObject({
        grants: JSON.stringify(grants),
        tokenHash: row.tokenHash,
      });
      expect(f.puts).toEqual([]);
    },
  );

  it.each(["app_nonexistent", APP])(
    "does not treat Org-to-%s replacement as cleanup",
    async (appId) => {
      const { row } = await f.seed([
        { target: `org:${ORG}`, role: "owner", permissions: ["write"] },
      ]);
      await loseMembership("both removed");
      const response = await f.call("PATCH", `/personal-access-tokens/${row.id}`, {
        grants: [{ ...readGrant, target: `app:${appId}` }],
      });
      expect(response.status).toBe(403);
      expect(await f.repo.personalAccessTokens.getForUser(USER, row.id)).toEqual(row);
      expect(f.puts).toEqual([]);
    },
  );

  it("keeps live membership validation for widening after Org removal even with approval", async () => {
    const { row } = await f.seed([{ target: `org:${ORG}`, role: "owner", permissions: [] }]);
    await loseMembership("Org removed");
    const response = await f.call(
      "PATCH",
      `/personal-access-tokens/${row.id}`,
      { grants: [{ ...readGrant, target: `app:${OTHER_APP}`, permissions: ["write"] }] },
      { approval: await f.approval() },
    );
    expect(response.status).toBe(400);
    expect(await f.repo.personalAccessTokens.getForUser(USER, row.id)).toEqual(row);
    expect(f.puts).toEqual([]);
  });
});
