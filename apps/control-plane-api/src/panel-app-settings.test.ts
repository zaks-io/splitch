import type { PanelAppSettings } from "@splitch/control-plane-sdk/panel-app-settings";
import { createRepository, type Repository } from "@splitch/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALPHA,
  BETA,
  principalFor,
  seedFlag,
  seedTwoTenants,
  USER_ADMIN,
  USER_BETA_OWNER,
  USER_BOTH,
  USER_CANDIDATE,
  USER_MEMBER,
  USER_OUTSIDER,
  USER_OWNER,
} from "./app-settings-fixture";
import { panelAppSettingsRead } from "./panel-app-settings";

/**
 * The composed App Settings read behind the binding-only entrypoint.
 *
 * Alpha and Beta hold deliberately different Flags, Variants, and people, so a
 * read that lost its `app_id` scope shows up as the other tenant's data rather
 * than as an empty list nobody notices.
 */

let dispose: () => Promise<void>;
let repo: Repository;
let d1: D1Database;

const EMAILS: Record<string, string> = {
  [USER_OWNER]: "owner@alpha.test",
  [USER_ADMIN]: "admin@alpha.test",
  [USER_CANDIDATE]: "candidate@alpha.test",
};

const deps = () => ({
  repo,
  // Resolves an email for some users and nothing for others, so the null case is
  // exercised rather than assumed away.
  memberProfileResolver: async ({ userId }: { userId: string }) => {
    const email = EMAILS[userId];
    return email ? { email } : null;
  },
});

const request = () => new Request("https://control-plane.test/binding");

async function read(userId: string, appId: string): Promise<Response> {
  return panelAppSettingsRead(deps(), { appId, actorId: userId }, request());
}

async function settings(userId: string, appId: string): Promise<PanelAppSettings> {
  const response = await read(userId, appId);
  expect(response.status).toBe(200);
  return (await response.json()) as PanelAppSettings;
}

beforeAll(async () => {
  const local = await seedTwoTenants();
  dispose = local.dispose;
  d1 = local.d1;
  repo = createRepository(d1);

  await seedFlag(d1, {
    appId: ALPHA.appId,
    flagId: "flag_alpha_checkout",
    key: "checkout-redesign",
    name: "Checkout redesign",
    defaultVariantId: "var_alpha_off",
    variants: [
      { id: "var_alpha_off", name: "off", value: JSON.stringify(false) },
      { id: "var_alpha_on", name: "on", value: JSON.stringify({ layout: "wide" }) },
    ],
  });
  await seedFlag(d1, {
    appId: ALPHA.appId,
    flagId: "flag_alpha_orphan",
    key: "orphan-default",
    name: "Orphan default",
    // Points at a Variant that belongs to the OTHER tenant's Flag.
    defaultVariantId: "var_beta_control",
    variants: [{ id: "var_alpha_solo", name: "solo", value: JSON.stringify("banner") }],
  });
  await seedFlag(d1, {
    appId: BETA.appId,
    flagId: "flag_beta_pricing",
    key: "pricing-test",
    name: "Pricing test",
    defaultVariantId: "var_beta_control",
    variants: [{ id: "var_beta_control", name: "control", value: JSON.stringify("a") }],
  });
});

afterAll(async () => {
  await dispose();
});

describe("App Settings read", () => {
  it("reports the viewer's live App role", async () => {
    expect((await settings(USER_OWNER, ALPHA.appId)).viewerRole).toBe("owner");
    expect((await settings(USER_MEMBER, ALPHA.appId)).viewerRole).toBe("member");
  });

  it("returns this App's access list, with a missing email left absent", async () => {
    const payload = await settings(USER_OWNER, ALPHA.appId);

    expect(payload.members.map((member) => member.userId).sort()).toEqual(
      [USER_ADMIN, USER_BOTH, USER_MEMBER, USER_OWNER].sort(),
    );
    expect(payload.members.every((member) => member.appId === ALPHA.appId)).toBe(true);
    expect(payload.members.find((member) => member.userId === USER_OWNER)?.email).toBe(
      "owner@alpha.test",
    );
    expect(payload.members.find((member) => member.userId === USER_MEMBER)?.email).toBeNull();
  });

  it("offers only Organization members who do not already have access", async () => {
    const payload = await settings(USER_OWNER, ALPHA.appId);

    expect(payload.candidates).toEqual([
      { userId: USER_CANDIDATE, email: "candidate@alpha.test", orgRole: "member" },
    ]);
  });

  it("returns this App's Flag catalog and no other App's", async () => {
    const payload = await settings(USER_OWNER, ALPHA.appId);

    expect(payload.flags.items.map((flag) => flag.key).sort()).toEqual([
      "checkout-redesign",
      "orphan-default",
    ]);
    const checkout = payload.flags.items.find((flag) => flag.key === "checkout-redesign");
    expect(checkout?.variants).toEqual([
      { id: "var_alpha_off", name: "off", value: "false" },
      { id: "var_alpha_on", name: "on", value: '{"layout":"wide"}' },
    ]);
    expect(checkout?.defaultVariantName).toBe("off");
    expect(payload.flags.readTruncated).toBe(false);
  });

  it("renders a string Variant value without its JSON quotes", async () => {
    const payload = await settings(USER_BETA_OWNER, BETA.appId);

    expect(payload.flags.items.map((flag) => flag.key)).toEqual(["pricing-test"]);
    expect(payload.flags.items[0]?.variants[0]?.value).toBe("a");
  });

  it("says the default Variant is missing rather than naming another App's", async () => {
    const payload = await settings(USER_OWNER, ALPHA.appId);
    const orphan = payload.flags.items.find((flag) => flag.key === "orphan-default");

    expect(orphan?.defaultVariantName).toBeNull();
  });

  it("shows the other tenant only its own people", async () => {
    const payload = await settings(USER_BETA_OWNER, BETA.appId);

    expect(payload.members.map((member) => member.userId).sort()).toEqual(
      [USER_BETA_OWNER, USER_BOTH].sort(),
    );
    expect(payload.app.id).toBe(BETA.appId);
  });
});

describe("App Settings refusals", () => {
  it("refuses an actor with no App membership", async () => {
    expect((await read(USER_OUTSIDER, ALPHA.appId)).status).toBe(403);
  });

  it("refuses the other tenant's owner", async () => {
    expect((await read(USER_BETA_OWNER, ALPHA.appId)).status).toBe(403);
  });

  it("refuses an unknown App", async () => {
    expect((await read(USER_OWNER, "app_does_not_exist")).status).toBe(404);
  });

  it("refuses a member whose Organization membership was revoked", async () => {
    // The App row lingers; Organization membership is gone. The recheck is live,
    // so the very next call refuses even though nothing about the claim changed.
    await d1
      .prepare("DELETE FROM org_memberships WHERE org_id = ? AND user_id = ?")
      .bind(ALPHA.orgId, USER_ADMIN)
      .run();

    expect((await read(USER_ADMIN, ALPHA.appId)).status).toBe(403);
    expect(principalFor(USER_ADMIN, ALPHA.appId).scopes).toContain(`app:${ALPHA.appId}:admin`);
  });
});
