import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";

const NOW = "2026-09-08T12:00:00.000Z";
let local: LocalD1;
let repo: ReturnType<typeof createRepository>;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
});

afterEach(async () => local.dispose());

describe("Organization ownership quota", () => {
  it("atomically refuses the first create beyond the limit", async () => {
    await expect(create("one", "user_1", 2)).resolves.toMatchObject({ ok: true });
    await expect(create("two", "user_1", 2)).resolves.toMatchObject({ ok: true });
    await expect(create("three", "user_1", 2)).resolves.toEqual({
      ok: false,
      reason: "creation_limit_exceeded",
      currentCount: 2,
    });

    const organizations = await local.d1
      .prepare("SELECT COUNT(*) AS count FROM organizations")
      .first<{ count: number }>();
    const memberships = await local.d1
      .prepare("SELECT COUNT(*) AS count FROM org_memberships")
      .first<{ count: number }>();
    expect(organizations?.count).toBe(2);
    expect(memberships?.count).toBe(2);
  }, 15_000);

  it("allows only one of two concurrent creates into the final slot", async () => {
    const results = await Promise.all([create("left", "user_1", 1), create("right", "user_1", 1)]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "creation_limit_exceeded", currentCount: 1 },
    ]);
    const organizations = await local.d1
      .prepare("SELECT COUNT(*) AS count FROM organizations")
      .first<{ count: number }>();
    expect(organizations?.count).toBe(1);
  }, 15_000);

  it("does not count provisional Organizations or member-only access", async () => {
    await create("demo", "user_1", undefined, true);
    await create("owned", "user_2", 1);
    await local.d1
      .prepare(
        "INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)",
      )
      .bind("org_owned", "user_1", NOW)
      .run();

    await expect(create("real", "user_1", 1)).resolves.toMatchObject({ ok: true });
  }, 15_000);
});

function create(
  suffix: string,
  userId: string,
  ownerOrganizationLimit?: number,
  provisional = false,
) {
  return repo.identity.createOrganization({
    organization: {
      id: `org_${suffix}`,
      name: suffix,
      slug: suffix,
      plan: "free",
      isProvisional: provisional,
      demoExpiresAt: provisional ? "2026-09-09T12:00:00.000Z" : null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    ownerUserId: userId,
    createdAt: NOW,
    ...(ownerOrganizationLimit === undefined ? {} : { ownerOrganizationLimit }),
  });
}
