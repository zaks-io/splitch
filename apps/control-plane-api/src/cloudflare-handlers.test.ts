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
import { makeCloudflareHandlers } from "./cloudflare-handlers";
import { seedEnvironment } from "./test-seeds";

const ALPHA_ENV = "env_alpha_cloudflare";
const BETA_ENV = "env_beta_cloudflare";
const ACTIVE_ID = "33333333-3333-4333-8333-333333333333";
const REVOKED_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-08-26T12:00:00.000Z";

let dispose: () => Promise<void>;
let d1: D1Database;
let repo: ReturnType<typeof createRepository>;
let handlers: ReturnType<typeof makeCloudflareHandlers>;

beforeEach(async () => {
  const local = await seedTwoTenants();
  dispose = local.dispose;
  d1 = local.d1;
  await seedEnvironment(d1, { appId: ALPHA.appId, environmentId: ALPHA_ENV, key: "prod" });
  await seedEnvironment(d1, { appId: BETA.appId, environmentId: BETA_ENV, key: "prod" });
  repo = createRepository(d1);
  handlers = makeCloudflareHandlers({ repo, now: () => new Date(NOW) });
});

afterEach(async () => dispose());

describe("Cloudflare Panel installations", () => {
  it("lists active and revoked installations with delivery health", async () => {
    await seedInstallations();
    const response = await handlers.panelList(panelArgs(USER_ADMIN, ALPHA.appId, ALPHA_ENV));
    const body = (await response.json()) as {
      installations: Array<{ installationId: string; status: string; pendingCount: number }>;
    };

    expect(response.status).toBe(200);
    expect(body.installations).toEqual([
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
    expect(await errorCode(response)).toBe("CLOUDFLARE_INSTALLATION_NOT_FOUND");
  });

  it("revokes idempotently", async () => {
    await create(ACTIVE_ID, NOW);
    const input = panelArgs(USER_ADMIN, ALPHA.appId, ALPHA_ENV, {
      installationId: ACTIVE_ID,
    });
    expect((await handlers.panelRemove(input)).status).toBe(204);
    expect((await handlers.panelRemove(input)).status).toBe(204);
    await expect(
      repo.cloudflare.getInstallation(envScope(ALPHA.appId, ALPHA_ENV), ACTIVE_ID),
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
      repo.cloudflare.getInstallation(envScope(ALPHA.appId, ALPHA_ENV), ACTIVE_ID),
    ).resolves.toMatchObject({ status: "active" });
  });
});

async function seedInstallations() {
  await create(REVOKED_ID, "2026-08-26T10:00:00.000Z");
  await repo.cloudflare.revokeInstallation(
    envScope(ALPHA.appId, ALPHA_ENV),
    REVOKED_ID,
    "2026-08-26T10:30:00.000Z",
  );
  await create(ACTIVE_ID, NOW);
}

function create(installationId: string, now: string) {
  return repo.cloudflare.createInstallation(envScope(ALPHA.appId, ALPHA_ENV), {
    installationId,
    endpoint: "https://splitch-config.customer.workers.dev/integrations/splitch/configuration",
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
