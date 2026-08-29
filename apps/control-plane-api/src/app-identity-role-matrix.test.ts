import { createRepository, type Repository } from "@splitch/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeAppHandlers } from "./app-handlers";
import type { EnvironmentExposureStatusCleanup } from "./environment-exposure-status-cleanup";
import {
  ALPHA,
  args,
  BETA,
  errorCode,
  seedFlag,
  seedTwoTenants,
  USER_ADMIN,
  USER_BETA_OWNER,
  USER_MEMBER,
  USER_OWNER,
} from "./app-settings-fixture";

/**
 * Rename, slug change, and delete against the App role matrix.
 *
 * Principals carry maximal App scopes throughout, so every refusal below comes
 * from the live `app_memberships` read rather than from the claim.
 */

const noOpExposureStatusCleanup: EnvironmentExposureStatusCleanup = {
  delete: async () => undefined,
};
const noOpHoldoverWriteOutboxCleanup = {
  prepare: async () => undefined,
  markD1Deleted: async () => undefined,
  finalize: async () => undefined,
  cancel: async () => undefined,
  delete: async () => undefined,
};

let dispose: () => Promise<void>;
let repo: Repository;
let handlers: ReturnType<typeof makeAppHandlers>;

beforeAll(async () => {
  const local = await seedTwoTenants();
  dispose = local.dispose;
  repo = createRepository(local.d1);
  handlers = makeAppHandlers({
    repo,
    membershipCache: { invalidate: async () => undefined },
    nowIso: () => "2026-08-07T00:00:00.000Z",
    // Force-delete runs Exposure status cleanup after the D1 cascade (main);
    // unit fixtures use a no-op so Tinybird is never required.
    exposureStatusCleanup: noOpExposureStatusCleanup,
    holdoverWriteOutboxCleanup: noOpHoldoverWriteOutboxCleanup,
  });

  await seedFlag(local.d1, {
    appId: ALPHA.appId,
    flagId: "flag_alpha_only",
    key: "alpha-only",
    name: "Alpha only",
    variants: [{ id: "var_alpha_only", name: "on", value: JSON.stringify(true) }],
  });
});

afterAll(async () => {
  await dispose();
});

async function appRow(appId: string) {
  const app = await repo.identity.getApp(appId);
  if (!app) throw new Error(`test fixture lost App ${appId}`);
  return app;
}

describe("renaming an App", () => {
  it("refuses a member", async () => {
    const response = await handlers.updateApp(
      args(USER_MEMBER, ALPHA.appId, { body: { name: "Member Rename" } }),
    );
    expect(response.status).toBe(403);
    expect((await appRow(ALPHA.appId)).name).toBe("Alpha App");
  });

  it("lets an admin change the name and the URL slug", async () => {
    const response = await handlers.updateApp(
      args(USER_ADMIN, ALPHA.appId, { body: { name: "Alpha Renamed", key: "alpha-renamed" } }),
    );
    expect(response.status).toBe(200);

    const app = await appRow(ALPHA.appId);
    expect(app.name).toBe("Alpha Renamed");
    expect(app.key).toBe("alpha-renamed");
  });

  it("refuses a slug already taken inside the Organization, naming it", async () => {
    // A second App in Alpha's Organization holds the slug being asked for.
    await repo.identity.createApp({
      id: "app_alpha_sibling",
      organizationId: ALPHA.orgId,
      name: "Sibling",
      key: "sibling-app",
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
      createdBy: USER_OWNER,
    });

    const response = await handlers.updateApp(
      args(USER_OWNER, ALPHA.appId, { body: { key: "sibling-app" } }),
    );
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("SLUG_CONFLICT");

    const payload = (await appRow(ALPHA.appId)).key;
    expect(payload).toBe("alpha-renamed");
  });

  it("allows a slug that is only taken in another Organization", async () => {
    const response = await handlers.updateApp(
      args(USER_OWNER, ALPHA.appId, { body: { key: BETA.appKey } }),
    );
    expect(response.status).toBe(200);
    expect((await appRow(ALPHA.appId)).key).toBe(BETA.appKey);
    // The other tenant's App is untouched by a slug it also holds.
    expect((await appRow(BETA.appId)).key).toBe(BETA.appKey);
  });

  it("refuses the other tenant's owner", async () => {
    const response = await handlers.updateApp(
      args(USER_BETA_OWNER, ALPHA.appId, { body: { name: "Taken over" } }),
    );
    expect(response.status).toBe(403);
    expect((await appRow(ALPHA.appId)).name).toBe("Alpha Renamed");
  });
});

describe("deleting an App", () => {
  it("refuses an admin: deleting is owner-only", async () => {
    const response = await handlers.deleteApp(args(USER_ADMIN, ALPHA.appId, {}));
    expect(response.status).toBe(403);
    expect(await repo.identity.getApp(ALPHA.appId)).not.toBeNull();
  });

  it("names what a delete would destroy, and destroys nothing", async () => {
    const response = await handlers.deleteApp({
      ...args(USER_OWNER, ALPHA.appId, {}),
      input: { params: { appId: ALPHA.appId }, query: { dryRun: true } },
    });
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      deleted: boolean;
      dryRun: boolean;
      blockers: { childType: string; children: { id: string }[] }[];
    };
    expect(payload).toMatchObject({ deleted: false, dryRun: true });
    expect(
      payload.blockers.flatMap((blocker) => blocker.children.map((child) => child.id)),
    ).toEqual(["flag_alpha_only"]);
    expect(await repo.identity.getApp(ALPHA.appId)).not.toBeNull();
  });

  it("refuses a non-empty App that was not forced, rather than cascading", async () => {
    const response = await handlers.deleteApp(args(USER_OWNER, ALPHA.appId, {}));
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("RESOURCE_NOT_EMPTY");
    expect(await repo.identity.getApp(ALPHA.appId)).not.toBeNull();
  });

  it("deletes only the named App when forced", async () => {
    const response = await handlers.deleteApp({
      ...args(USER_OWNER, ALPHA.appId, {}),
      input: { params: { appId: ALPHA.appId }, query: { force: true } },
    });
    expect(response.status).toBe(200);
    expect(await repo.identity.getApp(ALPHA.appId)).toBeNull();
    // The other tenant is still standing, with its Flags intact.
    expect(await repo.identity.getApp(BETA.appId)).not.toBeNull();
  });
});
