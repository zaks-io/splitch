import { env } from "cloudflare:workers";
import {
  CONTROL_PANEL_DELEGATION_HEADER,
  issueControlPanelDelegation,
} from "@splitch/control-plane-sdk/control-panel-identity";
import { appScope, createRepository } from "@splitch/db";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import { SignedControlPanelEntrypoint } from "../src/index.js";

const AUDIENCE = "https://cp.splitch.test";
const DELEGATION_SECRET = "test-control-panel-delegation-secret-1234";
const APP_ID = "app_panel_delete_resume";
const ORG_ID = "org_panel_delete_resume";
const OWNER = "user_panel_delete_owner";
const OTHER_ACTOR = "user_panel_delete_other";
const NOW = "2026-08-31T18:00:00.000Z";

const evaluationFetch = vi.fn(async () => Response.json({ deleted: true }));
const analysisFetch = vi.fn(async () => Response.json({ deleted: true }));

let testEnv: ControlPlaneApiEnv;

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organizations (id, name, slug, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(ORG_ID, "Panel Delete Resume", "panel-delete-resume", "free", NOW, NOW),
    env.DB.prepare(
      "INSERT INTO apps (id, organization_id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(APP_ID, ORG_ID, "Delete Resume", "delete-resume", NOW, NOW),
    env.DB.prepare(
      "INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
    ).bind(ORG_ID, OWNER, "owner", NOW),
    env.DB.prepare(
      "INSERT INTO app_memberships (app_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
    ).bind(APP_ID, OWNER, "owner", NOW),
  ]);

  const repo = createRepository(env.DB);
  const saga = await repo.identity.beginAppDeletionSaga({
    appId: APP_ID,
    generationId: "generation_panel_delete_resume",
    organizationId: ORG_ID,
    actorId: OWNER,
    deleteBeforeTs: NOW,
    now: NOW,
  });
  await repo.identity.deleteAppCascade(appScope(APP_ID), {
    generationId: saga.generationId,
    actorId: OWNER,
    organizationId: ORG_ID,
    deleteBeforeTs: NOW,
    updatedAt: NOW,
  });

  testEnv = {
    ...env,
    CONTROL_PLANE_ORIGIN: AUDIENCE,
    CONTROL_PANEL_DELEGATION_SECRET: DELEGATION_SECRET,
    EVALUATION_API: { fetch: evaluationFetch } as unknown as Fetcher,
    ANALYSIS_API: { fetch: analysisFetch } as unknown as Fetcher,
  } as ControlPlaneApiEnv;
});

describe("Signed Control Panel App deletion resume", () => {
  it("lets only the original Panel actor resume after the App row is gone", async () => {
    const entrypoint = new SignedControlPanelEntrypoint(testCtx, testEnv);

    const dryRun = await signedDelete(entrypoint, OWNER, "nonce_delete_resume_dry_run_1234", true);
    expect(dryRun.status).toBe(404);
    expect(await dryRun.json()).toMatchObject({ code: "APP_NOT_FOUND" });
    expect(evaluationFetch).not.toHaveBeenCalled();
    expect(analysisFetch).not.toHaveBeenCalled();

    const resumed = await signedDelete(entrypoint, OWNER, "nonce_delete_resume_owner_1234");

    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({ deleted: true });
    expect(await createRepository(env.DB).identity.getAppDeletionSaga(APP_ID)).toMatchObject({
      phase: "complete",
    });
    expect(evaluationFetch).toHaveBeenCalledTimes(2);
    expect(analysisFetch).toHaveBeenCalledOnce();

    const refused = await signedDelete(entrypoint, OTHER_ACTOR, "nonce_delete_resume_other_1234");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "FORBIDDEN" });
  });
});

const testCtx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

async function signedDelete(
  entrypoint: SignedControlPanelEntrypoint,
  actorId: string,
  nonce: string,
  dryRun = false,
): Promise<Response> {
  const query = dryRun ? "dryRun=true" : "force=true";
  const request = new Request(`${AUDIENCE}/apps/${APP_ID}?${query}`, { method: "DELETE" });
  request.headers.set(
    CONTROL_PANEL_DELEGATION_HEADER,
    await issueControlPanelDelegation(
      request,
      { id: "apps_delete", appId: APP_ID },
      actorId,
      DELEGATION_SECRET,
      {
        sessionExpiresAt: Math.floor(Date.now() / 1000) + 60,
        nonce,
      },
    ),
  );
  return entrypoint.fetch(request);
}
