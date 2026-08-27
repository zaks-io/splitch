import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository } from "../index";
import { appScope } from "./scope";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";

/**
 * Last-owner enforcement is a single scoped UPDATE/DELETE, not a count then a
 * later write. Two concurrent owner-loss attempts against real D1 must leave
 * exactly one owner (SPL-484).
 */

const NOW = "2026-08-27T00:00:00.000Z";
const APP = "app_last_owner";
const OTHER_APP = "app_other";
const OWNER_A = "user_owner_a";
const OWNER_B = "user_owner_b";
const MEMBER = "user_member";

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  await seedTwoOwnerApp(local.d1);
});

afterEach(async () => {
  await local.dispose();
});

describe("app membership last-owner is atomic on D1", () => {
  it("refuses a second owner demotion so exactly one owner remains", async () => {
    const scope = appScope(APP);
    const first = await repo.identity.updateAppMembership(scope, OWNER_A, { role: "admin" });
    const second = await repo.identity.updateAppMembership(scope, OWNER_B, { role: "admin" });

    expect(first?.role).toBe("admin");
    expect(second).toBeNull();
    expect(await ownerIds(APP)).toEqual([OWNER_B]);
  });

  it("refuses a second owner deletion so exactly one owner remains", async () => {
    const scope = appScope(APP);
    const first = await repo.identity.deleteAppMembership(scope, OWNER_A);
    const second = await repo.identity.deleteAppMembership(scope, OWNER_B);

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(await ownerIds(APP)).toEqual([OWNER_B]);
  });

  it("under concurrent demotions of both owners, exactly one write lands", async () => {
    const scope = appScope(APP);
    const [first, second] = await Promise.all([
      repo.identity.updateAppMembership(scope, OWNER_A, { role: "admin" }),
      repo.identity.updateAppMembership(scope, OWNER_B, { role: "admin" }),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await ownerIds(APP)).toHaveLength(1);
  });

  it("under concurrent deletions of both owners, exactly one write lands", async () => {
    const scope = appScope(APP);
    const [first, second] = await Promise.all([
      repo.identity.deleteAppMembership(scope, OWNER_A),
      repo.identity.deleteAppMembership(scope, OWNER_B),
    ]);

    expect([first, second].filter((count) => count === 1)).toHaveLength(1);
    expect(await ownerIds(APP)).toHaveLength(1);
  });

  it("still updates a non-owner and can add another owner", async () => {
    const scope = appScope(APP);
    const updated = await repo.identity.updateAppMembership(scope, MEMBER, { role: "admin" });
    expect(updated?.role).toBe("admin");

    const added = await repo.identity.createAppMembership(scope, {
      userId: "user_new_owner",
      role: "owner",
      createdAt: NOW,
    });
    expect(added.role).toBe("owner");
    expect(await ownerIds(APP)).toEqual(["user_new_owner", OWNER_A, OWNER_B]);
  });

  it("refusing the other App's last owner does not touch this App's owners", async () => {
    const demoted = await repo.identity.updateAppMembership(
      appScope(OTHER_APP),
      "user_other_owner",
      {
        role: "member",
      },
    );
    expect(demoted).toBeNull();
    expect(await ownerIds(OTHER_APP)).toEqual(["user_other_owner"]);
    expect(await ownerIds(APP)).toEqual([OWNER_A, OWNER_B]);
  });
});

async function ownerIds(appId: string): Promise<string[]> {
  const members = await repo.identity.listAppMembers(appScope(appId));
  return members
    .filter((row) => row.role === "owner")
    .map((row) => row.userId)
    .sort();
}

async function seedTwoOwnerApp(d1: D1Database): Promise<void> {
  await d1.batch([
    d1
      .prepare(
        `INSERT INTO organizations (id, name, slug, plan, created_at, updated_at)
         VALUES (?, ?, ?, 'free', ?, ?)`,
      )
      .bind("org_last_owner", "Last Owner Org", "org-last-owner", NOW, NOW),
    d1
      .prepare(
        `INSERT INTO apps (id, organization_id, name, key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(APP, "org_last_owner", "Last Owner App", "last-owner-app", NOW, NOW),
    d1
      .prepare(
        `INSERT INTO apps (id, organization_id, name, key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(OTHER_APP, "org_last_owner", "Other App", "other-app", NOW, NOW),
    d1
      .prepare(
        `INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES
         (?, ?, 'owner', ?), (?, ?, 'owner', ?), (?, ?, 'member', ?), (?, ?, 'owner', ?)`,
      )
      .bind(
        APP,
        OWNER_A,
        NOW,
        APP,
        OWNER_B,
        NOW,
        APP,
        MEMBER,
        NOW,
        OTHER_APP,
        "user_other_owner",
        NOW,
      ),
  ]);
}
