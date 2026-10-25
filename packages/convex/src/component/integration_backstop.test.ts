import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installed, snapshotAt } from "../testing/fake-convex-test-helpers";
import type { ActionCtx } from "./_generated/server";
import {
  checkSyncHandler,
  ensureSyncBackstopScheduled,
  SYNC_BACKSTOP_INTERVAL_MS,
  syncBackstopHandler,
} from "./integration_backstop";
import { revokeLocalHandler } from "./integration_cleanup";
import { initializeHandler } from "./integration_initialize";
import { activateHandler } from "./integration_recovery";
import { commitSnapshotHandler } from "./integration_sync";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("SPLITCH_API_KEY", "test-api-key");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function deployment(remoteVersion = 8) {
  const errors: unknown[] = [];
  const convex = installed(7, {
    "integration:syncBackstop": syncBackstopHandler,
    "integration:checkSync": async (_ctx, args) => {
      try {
        await checkSyncHandler(actionCtx, args);
      } catch (error) {
        errors.push(error);
      }
    },
  });
  Object.assign(convex.integration(), { endpoint: "https://edge.test" });
  const actionCtx = {
    runQuery: async () => convex.integration(),
    runMutation: async (_ref: unknown, args: { payload: string }) =>
      commitSnapshotHandler(convex.ctx, args),
  } as unknown as ActionCtx;
  const snapshotPull = vi.fn(() => Response.json(snapshotAt(remoteVersion)));
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    const headers = new Headers(options.headers);
    return headers.get("if-none-match") === `"${remoteVersion}"`
      ? new Response(null, { status: 304 })
      : snapshotPull();
  });
  vi.stubGlobal("fetch", fetcher);
  return { ...convex, actionCtx, snapshotPull, fetcher, errors };
}

describe("configuration sync backstop", () => {
  it("catches a lost nudge within ten minutes and does not pull an equal snapshot", async () => {
    const convex = deployment();
    await ensureSyncBackstopScheduled(convex.ctx);
    await convex.advance(SYNC_BACKSTOP_INTERVAL_MS);
    await convex.advance(1);
    expect(convex.integration().snapshotVersion).toBe(8);
    expect(convex.snapshotPull).toHaveBeenCalledOnce();
    await convex.advance(SYNC_BACKSTOP_INTERVAL_MS);
    await convex.advance(1);
    expect(convex.fetcher).toHaveBeenCalledTimes(2);
    expect(convex.snapshotPull).toHaveBeenCalledOnce();
  });

  it("keeps one durable chain through repeated activation, initialize, and redeploy", async () => {
    const convex = deployment(7);
    const runAfter = vi.spyOn(convex.ctx.scheduler, "runAfter");
    const activate = async () =>
      activateHandler(convex.ctx, {
        appId: "app_1",
        environmentId: "environment_1",
        environmentVersion: 7,
      });
    await activate();
    const firstJob = convex.integration().syncBackstopJobId;
    await activate();
    await initializeHandler(convex.ctx, {
      installationId: "unused",
      webhookSecret: "unused",
      componentIdentityKey: "unused",
      endpoint: "https://edge.test",
      callbackUrl: "https://example.convex.site/configuration",
    });
    expect(convex.integration().syncBackstopJobId).toBe(firstJob);
    // Durable integration and scheduler state persist when a deployment reloads its functions.
    await ensureSyncBackstopScheduled({ ...convex.ctx });
    expect(
      runAfter.mock.calls.filter((call) => getFunctionName(call[1]) === "integration:syncBackstop"),
    ).toHaveLength(1);
    await convex.advance(SYNC_BACKSTOP_INTERVAL_MS);
    await convex.advance(1);
    expect(convex.fetcher).toHaveBeenCalledOnce();
    expect(convex.integration().syncBackstopJobId).not.toBe(firstJob);
  });

  it("replaces a missing or failed scheduled job without duplicating a pending one", async () => {
    const convex = deployment();
    convex.integration().syncBackstopJobId = "missing";
    await ensureSyncBackstopScheduled(convex.ctx);
    const job = convex.integration().syncBackstopJobId;
    await ensureSyncBackstopScheduled(convex.ctx);
    expect(convex.integration().syncBackstopJobId).toBe(job);
  });

  it("continues after a failed network check", async () => {
    const convex = deployment();
    await ensureSyncBackstopScheduled(convex.ctx);
    convex.fetcher.mockRejectedValueOnce(new Error("network unavailable"));
    await convex.advance(SYNC_BACKSTOP_INTERVAL_MS);
    await convex.advance(1);
    expect(convex.errors).toHaveLength(1);
    expect(convex.integration().snapshotVersion).toBe(7);
    await convex.advance(SYNC_BACKSTOP_INTERVAL_MS);
    await convex.advance(1);
    expect(convex.integration().snapshotVersion).toBe(8);
  });

  it.each(["revoke", "cleanup"])(
    "stops after %s and ignores stale callbacks",
    async (operation) => {
      const convex = deployment();
      await ensureSyncBackstopScheduled(convex.ctx);
      const args = {
        installationId: "installation_1",
        dueAt: convex.integration().syncBackstopDueAt as number,
      };
      await revokeLocalHandler(convex.ctx);
      if (operation === "cleanup") convex.rows("integrations").splice(0);
      await syncBackstopHandler(convex.ctx, args);
      if (operation === "revoke") await ensureSyncBackstopScheduled(convex.ctx);
      await convex.advance(SYNC_BACKSTOP_INTERVAL_MS * 2);
      expect(convex.fetcher).not.toHaveBeenCalled();
      expect(convex.rows("integrations")[0]?.syncBackstopJobId).toBeUndefined();
    },
  );
});
