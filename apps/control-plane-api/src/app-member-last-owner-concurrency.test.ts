import { appScope, createRepository, type Repository } from "@splitch/db";
import { createLocalD1 } from "@splitch/db/test-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeAppMemberHandlers } from "./app-member-handlers";
import { args } from "./app-settings-fixture";
import { seedAppMember, seedOrgApp, seedOrgMember } from "./test-seeds";

/**
 * Concurrent owner-loss against the real D1 repository path, not a mock.
 * The handler maps the loser's 0-row mutation to LAST_OWNER_REQUIRED (SPL-484).
 */

const APP = "app_owner_race";
const OWNER_A = "user_race_owner_a";
const OWNER_B = "user_race_owner_b";

let dispose: () => Promise<void>;
let repo: Repository;
let handlers: ReturnType<typeof makeAppMemberHandlers>;

beforeEach(async () => {
  const local = await createLocalD1();
  dispose = local.dispose;
  await seedTwoOwners(local.d1);
  repo = createRepository(local.d1);
  handlers = makeAppMemberHandlers({
    repo,
    membershipCache: { invalidate: async () => undefined },
  });
});

afterEach(async () => {
  await dispose();
});

describe("concurrent App owner-loss on real D1", () => {
  it("demoting both owners leaves exactly one and 409s LAST_OWNER_REQUIRED once", async () => {
    const [first, second] = await Promise.all([
      handlers.updateAppMember(
        args(OWNER_A, APP, { params: { userId: OWNER_A }, body: { role: "admin" } }),
      ),
      handlers.updateAppMember(
        args(OWNER_A, APP, { params: { userId: OWNER_B }, body: { role: "admin" } }),
      ),
    ]);

    await expectExactlyOneLastOwnerRefusal([first, second]);
    expect(await ownerIds()).toHaveLength(1);
  });

  it("removing both owners leaves exactly one and 409s LAST_OWNER_REQUIRED once", async () => {
    const [first, second] = await Promise.all([
      handlers.removeAppMember(args(OWNER_A, APP, { params: { userId: OWNER_A } })),
      handlers.removeAppMember(args(OWNER_A, APP, { params: { userId: OWNER_B } })),
    ]);

    await expectExactlyOneLastOwnerRefusal([first, second]);
    expect(await ownerIds()).toHaveLength(1);
  });
});

async function expectExactlyOneLastOwnerRefusal(responses: Response[]): Promise<void> {
  const statuses = responses.map((response) => response.status).sort();
  expect(statuses).toEqual([200, 409]);

  const loser = responses.find((response) => response.status === 409);
  if (!loser) throw new Error("expected one LAST_OWNER_REQUIRED response");
  expect(await loser.json()).toMatchObject({
    code: "LAST_OWNER_REQUIRED",
    details: { appId: APP },
  });
}

async function ownerIds(): Promise<string[]> {
  const members = await repo.identity.listAppMembers(appScope(APP));
  return members.filter((row) => row.role === "owner").map((row) => row.userId);
}

async function seedTwoOwners(d1: D1Database): Promise<void> {
  await seedOrgApp(d1, {
    orgId: "org_owner_race",
    orgName: "Owner Race",
    appId: APP,
    appName: "Owner Race App",
    appKey: "owner-race",
  });
  for (const userId of [OWNER_A, OWNER_B]) {
    await seedOrgMember(d1, { orgId: "org_owner_race", userId, role: "owner" });
    await seedAppMember(d1, { appId: APP, userId, role: "owner" });
  }
}
