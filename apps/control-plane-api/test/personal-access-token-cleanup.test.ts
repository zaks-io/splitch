import type { PersonalAccessTokenGrant } from "@splitch/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APP,
  ORG,
  OTHER_APP,
  readGrant,
  stepUpFixture,
  USER,
} from "./personal-access-token-step-up-fixture";

let f: Awaited<ReturnType<typeof stepUpFixture>>;
beforeEach(async () => {
  f = await stepUpFixture();
});
afterEach(async () => {
  await f.bindings.dispose();
});

describe("stored PAT cleanup through real D1 routes", () => {
  it("narrows stored owner permissions after membership demotion without approval", async () => {
    const grant: PersonalAccessTokenGrant = {
      target: `app:${APP}`,
      role: "owner",
      permissions: ["write", "delete"],
    };
    const { row } = await f.seed([grant]);
    await f.bindings.d1.batch([
      f.bindings.d1
        .prepare("UPDATE org_memberships SET role = 'member' WHERE org_id = ? AND user_id = ?")
        .bind(ORG, USER),
      f.bindings.d1
        .prepare("UPDATE app_memberships SET role = 'member' WHERE app_id = ? AND user_id = ?")
        .bind(APP, USER),
    ]);

    const grants = [{ ...grant, permissions: ["write"] }];
    const response = await f.call("PATCH", `/personal-access-tokens/${row.id}`, { grants });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ grants, expiresAt: null });
    const narrowed = await f.repo.personalAccessTokens.getForUser(USER, row.id);
    expect(narrowed).toMatchObject({
      grants: JSON.stringify(grants),
      tokenHash: row.tokenHash,
    });
    const widened = await f.call(
      "PATCH",
      `/personal-access-tokens/${row.id}`,
      { grants: [grant] },
      { approval: await f.approval() },
    );
    expect(widened.status).toBe(400);
    expect(await f.repo.personalAccessTokens.getForUser(USER, row.id)).toEqual(narrowed);
    expect(f.puts).toHaveLength(0);
  });

  it("drops a grant while retaining a stored grant for a removed membership without approval", async () => {
    const retained: PersonalAccessTokenGrant = {
      target: `app:${OTHER_APP}`,
      role: "owner",
      permissions: ["write", "delete"],
    };
    const { row } = await f.seed([readGrant, retained]);
    await f.bindings.d1.batch([
      f.bindings.d1
        .prepare("DELETE FROM org_memberships WHERE org_id = ? AND user_id = ?")
        .bind("org_step_up_other", USER),
      f.bindings.d1
        .prepare("DELETE FROM app_memberships WHERE app_id = ? AND user_id = ?")
        .bind(OTHER_APP, USER),
    ]);

    const response = await f.call("PATCH", `/personal-access-tokens/${row.id}`, {
      grants: [retained],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ grants: [retained], expiresAt: null });
    expect(await f.repo.personalAccessTokens.getForUser(USER, row.id)).toMatchObject({
      grants: JSON.stringify([retained]),
      tokenHash: row.tokenHash,
    });
    expect(f.puts).toHaveLength(0);
  });

  it("preserves a committed concurrent rename during a grant-only update", async () => {
    const { row } = await f.seed([{ ...readGrant, permissions: ["write"] }]);
    const tokens = f.repo.personalAccessTokens;
    f.rebuild({
      ...f.repo,
      personalAccessTokens: {
        ...tokens,
        async updateAuthorized(current, patch, approval) {
          await tokens.updateAuthorized(current, { name: "renamed concurrently" });
          return tokens.updateAuthorized(current, patch, approval);
        },
      },
    });

    const response = await f.call("PATCH", `/personal-access-tokens/${row.id}`, {
      grants: [readGrant],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      name: "renamed concurrently",
      grants: [readGrant],
    });
    expect(await tokens.getForUser(USER, row.id)).toMatchObject({
      name: "renamed concurrently",
      grants: JSON.stringify([readGrant]),
    });
  });

  it("refuses stale cleanup after a concurrent authority change without overwriting it", async () => {
    const grants = [{ ...readGrant, permissions: ["write"] as const }];
    const { row } = await f.seed([{ ...readGrant, permissions: ["write", "delete"] }]);
    const tokens = f.repo.personalAccessTokens;
    f.rebuild({
      ...f.repo,
      personalAccessTokens: {
        ...tokens,
        async updateAuthorized(current, patch, approval) {
          await tokens.updateAuthorized(current, { grants: JSON.stringify(grants) });
          return tokens.updateAuthorized(current, patch, approval);
        },
      },
    });

    const response = await f.call("PATCH", `/personal-access-tokens/${row.id}`, {
      grants: [readGrant],
    });
    expect(response.status).toBe(403);
    expect(await tokens.getForUser(USER, row.id)).toMatchObject({
      grants: JSON.stringify(grants),
      tokenHash: row.tokenHash,
    });
    expect(f.puts).toHaveLength(0);
  });
});
