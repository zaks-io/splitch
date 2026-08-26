import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository, envScope } from "../index";
import { createLocalD1, type LocalD1 } from "./test-d1-pool";
import { type SeededTenants, seedSiblingEnvironment, seedTwoTenants } from "./test-seed";

const NOW = "2026-08-25T00:00:00.000Z";
const LATER = "2026-08-25T00:05:00.000Z";
const FIRST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000011";
const ACTIVE_INSTALLATION_ID = "00000000-0000-4000-8000-000000000012";
const FOREIGN_INSTALLATION_ID = "00000000-0000-4000-8000-000000000013";
const CALLBACK_URL = "https://example.convex.site/splitch/configuration";
const SIBLING_ENVIRONMENT_ID = "env_a_sibling";
const SIBLING_INSTALLATION_ID = "00000000-0000-4000-8000-000000000014";

let local: LocalD1;
let repo: ReturnType<typeof createRepository>;
let seed: SeededTenants;

beforeEach(async () => {
  local = await createLocalD1();
  repo = createRepository(local.d1);
  seed = await seedTwoTenants(local.d1);
});

afterEach(async () => local.dispose());

function install(tenant: "a" | "b", installationId: string, now = NOW) {
  const scope = seed[tenant];
  return repo.convex.createInstallation(envScope(scope.appId, scope.environmentId), {
    installationId,
    callbackUrl: CALLBACK_URL,
    secretCiphertext: "ciphertext",
    secretKeyVersion: "v1",
    secretFingerprint: "fingerprint",
    now,
  });
}

describe("Convex integration repository", () => {
  it("lists active and revoked installation health without crossing tenant scope", async () => {
    const scope = envScope(seed.a.appId, seed.a.environmentId);
    await install("a", FIRST_INSTALLATION_ID);
    await repo.convex.revokeInstallation(scope, FIRST_INSTALLATION_ID, LATER);
    await install("a", ACTIVE_INSTALLATION_ID, LATER);
    await install("b", FOREIGN_INSTALLATION_ID, LATER);
    await local.d1.batch([
      local.d1
        .prepare(`INSERT INTO config_webhook_deliveries (
          delivery_id, installation_id, app_id, environment_id, environment_version,
          body_json, state, attempt_count, next_attempt_at, created_at
        ) VALUES (?, ?, ?, ?, 1, '{}', 'pending', 0, ?, ?)`)
        .bind(
          "00000000-0000-4000-8000-000000000014",
          ACTIVE_INSTALLATION_ID,
          scope.appId,
          scope.environmentId,
          NOW,
          NOW,
        ),
      local.d1
        .prepare(`INSERT INTO config_webhook_deliveries (
          delivery_id, installation_id, app_id, environment_id, environment_version,
          body_json, state, attempt_count, next_attempt_at, created_at
        ) VALUES (?, ?, ?, ?, 2, '{}', 'terminal', 0, ?, ?)`)
        .bind(
          "00000000-0000-4000-8000-000000000015",
          ACTIVE_INSTALLATION_ID,
          scope.appId,
          scope.environmentId,
          NOW,
          NOW,
        ),
    ]);

    const rows = await repo.convex.listInstallations(scope);

    expect(rows.map((row) => row.installationId)).toEqual([
      ACTIVE_INSTALLATION_ID,
      FIRST_INSTALLATION_ID,
    ]);
    expect(rows[0]).toMatchObject({
      appId: seed.a.appId,
      environmentId: seed.a.environmentId,
      status: "active",
      pendingCount: 1,
      terminalCount: 1,
      oldestPendingAgeMs: expect.any(Number),
    });
    expect(rows[1]).toMatchObject({
      appId: seed.a.appId,
      environmentId: seed.a.environmentId,
      status: "revoked",
      pendingCount: 0,
      terminalCount: 0,
      oldestPendingAgeMs: null,
    });
    expect(rows.some((row) => row.installationId === FOREIGN_INSTALLATION_ID)).toBe(false);
  });

  it("scopes the list on the App and on the Environment independently", async () => {
    await seedSiblingEnvironment(local.d1, seed.a, SIBLING_ENVIRONMENT_ID);
    await install("a", FIRST_INSTALLATION_ID);
    await repo.convex.createInstallation(envScope(seed.a.appId, SIBLING_ENVIRONMENT_ID), {
      installationId: SIBLING_INSTALLATION_ID,
      callbackUrl: CALLBACK_URL,
      secretCiphertext: "ciphertext",
      secretKeyVersion: "v1",
      secretFingerprint: "fingerprint",
      now: NOW,
    });
    await install("b", FOREIGN_INSTALLATION_ID);

    // Same App, different Environment. Only the `environment_id` predicate
    // excludes this row; the foreign-tenant row below cannot prove that
    // predicate, because it differs on both columns.
    const own = await repo.convex.listInstallations(envScope(seed.a.appId, seed.a.environmentId));
    expect(own.map((row) => row.installationId)).toEqual([FIRST_INSTALLATION_ID]);

    // Tenant B's Environment named under tenant A's App: the scope a confused
    // deputy mints. Only the `app_id` predicate excludes it.
    const mismatched = await repo.convex.listInstallations(
      envScope(seed.a.appId, seed.b.environmentId),
    );
    expect(mismatched).toEqual([]);
  });
});
