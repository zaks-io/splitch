import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1";

/**
 * The batched session reads, against the real generated schema.
 *
 * These replaced a per-membership `getOrg` + per-App `getAppMembership` loop
 * whose cost was 2N+1 sequential D1 queries inside one Worker invocation. The
 * unit suite proves the query count is flat; this suite proves the SQL actually
 * returns the same rows the loop did, because a fast query that answers wrong is
 * not a fix.
 */

const NOW = "2026-07-29T08:00:00.000Z";

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
});

afterEach(async () => {
  await local.dispose();
});

describe("batched session membership reads", () => {
  it("joins Organizations onto the User's memberships in one query", async () => {
    await seed(local.d1);

    const rows = await repo.identity.listOrgMembershipsWithOrgForUser("user_1", 10);

    // Newest membership first: the row a LIMIT gives up must be the one the User
    // has gone longest without acquiring, never the one they just created.
    expect(rows.map((row) => ({ role: row.role, id: row.org?.id, slug: row.org?.slug }))).toEqual([
      { role: "member", id: "org_2", slug: "org-two" },
      { role: "owner", id: "org_1", slug: "org-one" },
    ]);
  }, 15_000);

  // The join is LEFT so a membership pointing at a missing Organization surfaces
  // as a null the caller can refuse, rather than a row an inner join would drop
  // (which would read as a complete, smaller list). This pins down why that
  // branch is only reachable in the unit fake: the generated schema refuses to
  // create the state at all, so the LEFT join is defense in depth, not dead code
  // covering a routine case.
  it("cannot be given a dangling membership, because the schema refuses one", async () => {
    await seed(local.d1);

    await expect(
      local.d1
        .prepare("INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)")
        .bind("org_vanished", "user_1", "member", "2026-07-29T09:00:00.000Z")
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  }, 15_000);

  it("gives up the oldest membership to the limit, never the newest", async () => {
    await seed(local.d1);

    const rows = await repo.identity.listOrgMembershipsWithOrgForUser("user_1", 1);

    expect(rows).toHaveLength(1);
    // org_2 is the newer membership. Ascending order would have kept org_1 here,
    // which is the create-at-cap case dropping the Organization just created.
    expect(rows[0]?.org?.id).toBe("org_2");
  }, 15_000);

  it("returns only the User's own App memberships, keyed by owning Organization", async () => {
    await seed(local.d1);

    const rows = await repo.identity.listAppMembershipsWithAppForUser("user_1", ["org_1", "org_2"]);

    expect(rows.map((row) => ({ app: row.app.id, org: row.app.organizationId }))).toEqual([
      { app: "app_1", org: "org_1" },
      { app: "app_3", org: "org_2" },
    ]);
  }, 15_000);

  it("does not leak Apps from an Organization the caller did not ask for", async () => {
    await seed(local.d1);

    const rows = await repo.identity.listAppMembershipsWithAppForUser("user_1", ["org_1"]);

    expect(rows.map((row) => row.app.id)).toEqual(["app_1"]);
  }, 15_000);

  it("issues no query at all when there are no Organizations to look in", async () => {
    let prepared = 0;
    const counting = new Proxy(local.d1, {
      get(target, property, receiver) {
        if (property === "prepare") {
          prepared += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const rows = await createRepository(counting).identity.listAppMembershipsWithAppForUser(
      "user_1",
      [],
    );

    expect(rows).toEqual([]);
    expect(prepared).toBe(0);
  }, 15_000);
});

/**
 * `user_1` owns org_1 and is a member of org_2. `app_2` sits in org_1 but
 * `user_1` has NO membership on it, so a query that returned it would be
 * returning an App the User cannot see.
 */
async function seed(d1: D1Database): Promise<void> {
  const statements = [
    `INSERT INTO organizations (id, name, slug, plan, is_provisional, created_at, updated_at) VALUES
       ('org_1', 'Org One', 'org-one', 'free', 0, '${NOW}', '${NOW}'),
       ('org_2', 'Org Two', 'org-two', 'free', 0, '${NOW}', '${NOW}')`,
    `INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES
       ('org_1', 'user_1', 'owner', '2026-07-29T08:00:00.000Z'),
       ('org_2', 'user_1', 'member', '2026-07-29T08:30:00.000Z'),
       ('org_1', 'user_2', 'member', '${NOW}')`,
    `INSERT INTO apps (id, organization_id, name, key, created_at, updated_at, created_by) VALUES
       ('app_1', 'org_1', 'App One', 'app-one', '${NOW}', '${NOW}', 'user_1'),
       ('app_2', 'org_1', 'App Two', 'app-two', '${NOW}', '${NOW}', 'user_2'),
       ('app_3', 'org_2', 'App Three', 'app-three', '2026-07-29T09:00:00.000Z', '${NOW}', 'user_1')`,
    `INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES
       ('app_1', 'user_1', 'owner', '${NOW}'),
       ('app_2', 'user_2', 'owner', '${NOW}'),
       ('app_3', 'user_1', 'viewer', '${NOW}')`,
  ];
  for (const statement of statements) {
    await d1.prepare(statement).run();
  }
}
