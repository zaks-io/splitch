import { createRepository } from "@splitch/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { makeSentryHandlers } from "./sentry-handlers";
import { seedEnvironment } from "./test-seeds";

/**
 * The Sentry installation routes as the Panel and an agent both reach them:
 * App and Environment from the path, authority from live App membership.
 *
 * A 32-byte AES key, base64. Test-only: it seals nothing that outlives the run.
 */
const KEK = btoa("0123456789abcdef0123456789abcdef");
const ALPHA_ENV = "env_alpha_prod";
const BETA_ENV = "env_beta_prod";
const WEBHOOK = "https://zaksio.sentry.io/api/0/organizations/zaksio/flags/hooks/provider/generic/";
const INSTALL_ID = "11111111-1111-4111-8111-111111111111";

let dispose: () => Promise<void>;
let handlers: ReturnType<typeof makeSentryHandlers>;

beforeAll(async () => {
  const local = await seedTwoTenants();
  dispose = local.dispose;
  await seedEnvironment(local.d1, { appId: ALPHA.appId, environmentId: ALPHA_ENV, key: "prod" });
  await seedEnvironment(local.d1, { appId: BETA.appId, environmentId: BETA_ENV, key: "prod" });
  handlers = makeSentryHandlers({
    repo: createRepository(local.d1),
    secretKek: KEK,
    secretKeyVersion: "v1",
    now: () => new Date("2026-08-26T00:00:00.000Z"),
  });
});

afterAll(async () => {
  await dispose();
});

function install(userId: string, appId: string, environmentId: string, body: object) {
  return args(userId, appId, { params: { environmentId }, body: body as Record<string, unknown> });
}

describe("sentry installations: minting the signing secret", () => {
  it("returns a secret exactly once when the caller supplies none", async () => {
    const response = await handlers.create(
      install(USER_ADMIN, ALPHA.appId, ALPHA_ENV, {
        installationId: INSTALL_ID,
        webhookUrl: WEBHOOK,
      }),
    );
    const created = (await response.json()) as { webhookSecret?: string; status: string };
    expect(response.status).toBe(200);
    expect(created.status).toBe("active");
    // Sentry's documented bound is 10-64 characters, and this is what the
    // operator pastes into the Add-Provider form.
    expect(created.webhookSecret).toMatch(/^[0-9a-f]{64}$/);

    const read = await handlers.get(
      args(USER_ADMIN, ALPHA.appId, {
        params: { environmentId: ALPHA_ENV, installationId: INSTALL_ID },
      }),
    );
    expect(await read.json()).not.toHaveProperty("webhookSecret");
  });

  it("stores a caller-supplied secret verbatim and returns none", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const response = await handlers.create(
      install(USER_BETA_OWNER, BETA.appId, BETA_ENV, {
        installationId: id,
        webhookUrl: WEBHOOK,
        webhookSecret: "agent-held-secret-value",
      }),
    );
    expect(await response.json()).not.toHaveProperty("webhookSecret");
  });

  it("replaying an installationId with a minted secret is not a conflict", async () => {
    const replay = await handlers.create(
      install(USER_ADMIN, ALPHA.appId, ALPHA_ENV, {
        installationId: INSTALL_ID,
        webhookUrl: WEBHOOK,
      }),
    );
    expect(replay.status).toBe(200);
    // The first call held the only copy; a replay must not imply a second one.
    expect(await replay.json()).not.toHaveProperty("webhookSecret");
  });

  it("replaying an installationId against a different Sentry org conflicts", async () => {
    const replay = await handlers.create(
      install(USER_ADMIN, ALPHA.appId, ALPHA_ENV, {
        installationId: INSTALL_ID,
        webhookUrl: "https://sentry.io/api/0/organizations/other/flags/hooks/provider/generic/",
      }),
    );
    expect(await errorCode(replay)).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });
});

describe("sentry installations: authority and tenant scope", () => {
  it("refuses an App member who is not an admin", async () => {
    const response = await handlers.create(
      install(USER_MEMBER, ALPHA.appId, ALPHA_ENV, {
        installationId: "33333333-3333-4333-8333-333333333333",
        webhookUrl: WEBHOOK,
      }),
    );
    expect(await errorCode(response)).toBe("FORBIDDEN");
    // The refusal has to be a refusal to write, not a refusal to answer.
    const read = await handlers.get(
      args(USER_ADMIN, ALPHA.appId, {
        params: {
          environmentId: ALPHA_ENV,
          installationId: "33333333-3333-4333-8333-333333333333",
        },
      }),
    );
    expect(await errorCode(read)).toBe("SENTRY_INSTALLATION_NOT_FOUND");
  });

  it("refuses a non-Sentry webhook host", async () => {
    const response = await handlers.create(
      install(USER_ADMIN, ALPHA.appId, ALPHA_ENV, {
        installationId: "44444444-4444-4444-8444-444444444444",
        webhookUrl: "https://attacker.example/api/0/organizations/x/flags/hooks/provider/generic/",
      }),
    );
    expect(await errorCode(response)).toBe("VALIDATION_ERROR");
  });

  it("lists only the installations of the Environment in the path", async () => {
    const alpha = await handlers.list(
      args(USER_ADMIN, ALPHA.appId, { params: { environmentId: ALPHA_ENV } }),
    );
    const beta = await handlers.list(
      args(USER_BETA_OWNER, BETA.appId, { params: { environmentId: BETA_ENV } }),
    );
    const alphaBody = (await alpha.json()) as { installations: { installationId: string }[] };
    const betaBody = (await beta.json()) as { installations: { installationId: string }[] };
    expect(alphaBody.installations.map((row) => row.installationId)).toEqual([INSTALL_ID]);
    expect(betaBody.installations.map((row) => row.installationId)).toEqual([
      "22222222-2222-4222-8222-222222222222",
    ]);
  });

  it("cannot read another tenant's installation through its own path", async () => {
    const response = await handlers.get(
      args(USER_BETA_OWNER, BETA.appId, {
        params: { environmentId: BETA_ENV, installationId: INSTALL_ID },
      }),
    );
    expect(await errorCode(response)).toBe("SENTRY_INSTALLATION_NOT_FOUND");
  });
});

describe("sentry installations: rotation and revocation", () => {
  it("mints and returns a fresh secret on rotation", async () => {
    const response = await handlers.rotate(
      args(USER_ADMIN, ALPHA.appId, {
        params: { environmentId: ALPHA_ENV, installationId: INSTALL_ID },
        body: { rotationId: "55555555-5555-4555-8555-555555555555" },
      }),
    );
    const rotated = (await response.json()) as { webhookSecret?: string; status: string };
    expect(rotated.status).toBe("active");
    expect(rotated.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("revokes, and the revoked row stays visible as history", async () => {
    const response = await handlers.remove(
      args(USER_ADMIN, ALPHA.appId, {
        params: { environmentId: ALPHA_ENV, installationId: INSTALL_ID },
      }),
    );
    expect(response.status).toBe(204);
    const list = await handlers.list(
      args(USER_ADMIN, ALPHA.appId, { params: { environmentId: ALPHA_ENV } }),
    );
    const body = (await list.json()) as { installations: { status: string }[] };
    expect(body.installations.map((row) => row.status)).toEqual(["revoked"]);
  });
});
