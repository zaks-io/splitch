import { ConvexInstallationListResponseSchema } from "@splitch/contracts";
import { createRepository, envScope } from "@splitch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALPHA,
  args,
  BETA,
  errorCode,
  seedTwoTenants,
  USER_ADMIN,
  USER_BETA_OWNER,
  USER_MEMBER,
} from "./app-settings-fixture";
import { makeConvexHandlers } from "./convex-handlers";
import { seedEnvironment } from "./test-seeds";

const ALPHA_ENV = "env_alpha_convex";
const BETA_ENV = "env_beta_convex";
const ACTIVE_ID = "11111111-1111-4111-8111-111111111111";
const REVOKED_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-08-26T12:00:00.000Z";

let dispose: () => Promise<void>;
let d1: D1Database;
let repo: ReturnType<typeof createRepository>;
let handlers: ReturnType<typeof makeConvexHandlers>;

beforeEach(async () => {
  const local = await seedTwoTenants();
  dispose = local.dispose;
  d1 = local.d1;
  await seedEnvironment(d1, { appId: ALPHA.appId, environmentId: ALPHA_ENV, key: "prod" });
  await seedEnvironment(d1, { appId: BETA.appId, environmentId: BETA_ENV, key: "prod" });
  repo = createRepository(d1);
  handlers = makeConvexHandlers({ repo, now: () => new Date(NOW) });
});

afterEach(async () => dispose());

describe("Convex Panel installations", () => {
  it("lists active and revoked installations with delivery health", async () => {
    await seedInstallations();
    const response = await handlers.panelList(panelArgs(USER_ADMIN, ALPHA.appId, ALPHA_ENV));
    const body = ConvexInstallationListResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.items).toEqual([
      expect.objectContaining({
        installationId: ACTIVE_ID,
        status: "active",
        pendingCount: 1,
      }),
      expect.objectContaining({
        installationId: REVOKED_ID,
        status: "revoked",
        pendingCount: 0,
      }),
    ]);
  });

  it("refuses an App member who is not an admin", async () => {
    const response = await handlers.panelList(panelArgs(USER_MEMBER, ALPHA.appId, ALPHA_ENV));
    expect(await errorCode(response)).toBe("FORBIDDEN");
  });

  it("returns not found when the scoped installation does not exist", async () => {
    const response = await handlers.panelRemove(
      panelArgs(USER_ADMIN, ALPHA.appId, ALPHA_ENV, {
        installationId: "99999999-9999-4999-8999-999999999999",
      }),
    );
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("CONVEX_INSTALLATION_NOT_FOUND");
  });

  it("revokes idempotently", async () => {
    await create(ACTIVE_ID, NOW);
    const input = panelArgs(USER_ADMIN, ALPHA.appId, ALPHA_ENV, {
      installationId: ACTIVE_ID,
    });
    expect((await handlers.panelRemove(input)).status).toBe(204);
    expect((await handlers.panelRemove(input)).status).toBe(204);
    await expect(
      repo.convex.getInstallation(envScope(ALPHA.appId, ALPHA_ENV), ACTIVE_ID),
    ).resolves.toMatchObject({ status: "revoked" });
  });

  it("does not let an admin of another App list or revoke this App's installation", async () => {
    await create(ACTIVE_ID, NOW);
    const list = await handlers.panelList(panelArgs(USER_BETA_OWNER, ALPHA.appId, ALPHA_ENV));
    const remove = await handlers.panelRemove(
      panelArgs(USER_BETA_OWNER, ALPHA.appId, ALPHA_ENV, { installationId: ACTIVE_ID }),
    );
    expect(await errorCode(list)).toBe("FORBIDDEN");
    expect(await errorCode(remove)).toBe("FORBIDDEN");
    await expect(
      repo.convex.getInstallation(envScope(ALPHA.appId, ALPHA_ENV), ACTIVE_ID),
    ).resolves.toMatchObject({ status: "active" });
  });

  it("never puts the encrypted push secret on the wire", async () => {
    await seedInstallations();
    const raw = await (
      await handlers.panelList(panelArgs(USER_ADMIN, ALPHA.appId, ALPHA_ENV))
    ).text();

    // `INSTALLATION_SELECT` carries the KEK ciphertext, its key version, and its
    // fingerprint into the handler because the delivery path shares the query.
    // The response shaper's field list is the only thing keeping them off the
    // wire, so assert their absence rather than the presence of the good fields.
    expect(raw).toContain(ACTIVE_ID);
    expect(raw).not.toContain("cipher_");
    expect(raw).not.toContain("fingerprint_");
    expect(raw).not.toContain("secretKeyVersion");
  });

  it("returns an empty list for an Environment that is not in this App", async () => {
    const response = await handlers.panelList(
      panelArgs(USER_ADMIN, ALPHA.appId, "env_does_not_exist"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [],
      readLimit: 200,
      readTruncated: false,
      cursor: null,
    });
  });
});

async function seedInstallations() {
  await create(REVOKED_ID, "2026-08-26T10:00:00.000Z");
  await repo.convex.revokeInstallation(
    envScope(ALPHA.appId, ALPHA_ENV),
    REVOKED_ID,
    "2026-08-26T10:30:00.000Z",
  );
  await create(ACTIVE_ID, NOW);
  await d1
    .prepare("UPDATE environments SET config_version = 1 WHERE app_id = ? AND id = ?")
    .bind(ALPHA.appId, ALPHA_ENV)
    .run();
}

function create(installationId: string, now: string) {
  return repo.convex.createInstallation(envScope(ALPHA.appId, ALPHA_ENV), {
    installationId,
    callbackUrl: "https://customer.convex.site/integrations/splitch/configuration",
    secretCiphertext: `cipher_${installationId}`,
    secretKeyVersion: "v1",
    secretFingerprint: `fingerprint_${installationId}`,
    now,
  });
}

function panelArgs(
  userId: string,
  appId: string,
  environmentId: string,
  params: Record<string, string> = {},
) {
  return args(userId, appId, { params: { environmentId, ...params } });
}
