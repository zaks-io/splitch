import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { AuthResolver, RateLimiter } from "@splitch/worker-runtime";
import { createRepository } from "@splitch/db";
import { afterEach, beforeEach } from "vitest";
import { type LocalBindings, makeLocalBindings } from "./test-fixtures";
import type { EnvironmentExposureStatusCleanupInput } from "./environment-exposure-status-cleanup";
import type { HoldoverWriteOutboxCleanup } from "./holdover-write-outbox-cleanup";

const APP_ID = "app_finalize_resume";
const ORG_ID = "org_finalize_resume";

let bindings: LocalBindings;

beforeEach(async () => {
  bindings = await makeLocalBindings();
  await bindings.d1.batch([
    bindings.d1
      .prepare(
        "INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(ORG_ID, "Resume Org", "resume-org", "2026-08-18", "2026-08-18"),
    bindings.d1
      .prepare(
        "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(APP_ID, ORG_ID, "Resume App", "resume-app", "2026-08-18", "2026-08-18"),
    bindings.d1
      .prepare(
        "INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(APP_ID, "user_owner", "owner", "2026-08-18"),
  ]);
});

afterEach(async () => bindings.dispose());

describe("App delete public finalize resume after D1 cascade", () => {
  it("DELETE retry after finalize failure completes without cancel/rollback", async () => {
    const phases: string[] = [];
    let finalizeFailsRemaining = 1;
    const holdover: HoldoverWriteOutboxCleanup = {
      async prepare() {
        phases.push("prepare");
      },
      async markD1Deleted() {
        phases.push("mark-d1-deleted");
      },
      async finalize() {
        phases.push("finalize");
        if (finalizeFailsRemaining > 0) {
          finalizeFailsRemaining -= 1;
          const { HoldoverWriteOutboxCleanupError } = await import(
            "./holdover-write-outbox-cleanup"
          );
          throw new HoldoverWriteOutboxCleanupError(
            "control-plane-api: holdover write outbox cleanup failed with HTTP 503",
          );
        }
      },
      async cancel() {
        phases.push("cancel");
      },
      async delete() {
        phases.push("delete");
      },
    };
    const exposures: EnvironmentExposureStatusCleanupInput[] = [];
    const app = createTestApp(holdover, exposures);

    const first = await app.request(`/apps/${APP_ID}`, { method: "DELETE" });
    expect(first.status).toBe(503);
    expect(await createRepository(bindings.d1).identity.getApp(APP_ID)).toBeNull();
    expect(phases).toEqual(["prepare", "mark-d1-deleted", "finalize"]);
    expect(phases).not.toContain("cancel");

    const retry = await app.request(`/apps/${APP_ID}`, { method: "DELETE" });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ deleted: true });
    expect(phases).toEqual([
      "prepare",
      "mark-d1-deleted",
      "finalize",
      "mark-d1-deleted",
      "finalize",
    ]);
    expect(phases.filter((phase) => phase === "cancel")).toEqual([]);
    expect(exposures).toHaveLength(1);
  });
});

function createTestApp(
  holdover: HoldoverWriteOutboxCleanup,
  exposures: EnvironmentExposureStatusCleanupInput[],
) {
  const authResolver: AuthResolver = () => ({
    ok: true,
    principal: {
      kind: "control-plane-token",
      id: "user_owner",
      scopes: [`app:${APP_ID}:owner`],
      orgId: ORG_ID,
      appId: APP_ID,
      environmentId: null,
      authDoor: "device_flow",
    },
  });
  const rateLimiter: RateLimiter = () => ({ limited: false });
  return createApp({
    authResolver,
    rateLimiter,
    repo: createRepository(bindings.d1),
    credentialStore: bindings.credentialKv,
    exposureStatusCleanup: {
      delete: async (input) => {
        exposures.push(input);
      },
    },
    holdoverWriteOutboxCleanup: holdover,
  });
}
