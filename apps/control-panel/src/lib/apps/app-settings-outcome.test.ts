import { describe, expect, it, vi } from "vitest";
import { settleAppDelete, settleAppMutation } from "#lib/apps/app-settings-outcome";

/**
 * Renaming or deleting an App changes what the session says about itself, so the
 * mutation is followed by a session resync. The three outcomes have to stay
 * distinguishable (SPL-203): a resync failure means the App WAS renamed and the
 * session is stale, which is nothing like a refused rename.
 */
describe("settleAppMutation", () => {
  const ok = { ok: true, status: 200, data: { id: "app_1", key: "renamed" } } as const;

  it("reports a clean mutation with a healthy session", async () => {
    const settled = await settleAppMutation(ok, async () => {});

    expect(settled).toEqual({ ...ok, sessionResync: { ok: true } });
  });

  it("keeps a refusal a refusal, and never resyncs behind it", async () => {
    let resyncs = 0;
    const refused = {
      ok: false,
      status: 403,
      error: { code: "FORBIDDEN", message: "not allowed", details: {} },
    } as const;

    const settled = await settleAppMutation(refused, async () => {
      resyncs += 1;
    });

    expect(settled).toBe(refused);
    expect(resyncs).toBe(0);
  });

  it("still reports success when the session could not be refreshed, and says why", async () => {
    const settled = await settleAppMutation(ok, async () => {
      throw new Error("D1 is unreachable");
    });

    expect(settled.ok).toBe(true);
    expect(settled.ok && settled.sessionResync).toEqual({
      ok: false,
      reason: "D1 is unreachable",
      remedy: "retry",
    });
  });

  it("offers re-authentication only for the failures signing in again repairs", async () => {
    const settled = await settleAppMutation(ok, async () => {
      throw Object.assign(new Error("session expired"), { remedy: "reauth" });
    });

    expect(settled.ok && settled.sessionResync).toEqual({
      ok: false,
      reason: "session expired",
      remedy: "reauth",
    });
  });
});

describe("settleAppDelete", () => {
  const partial = {
    ok: false,
    status: 503,
    error: {
      code: "SERVICE_UNAVAILABLE",
      message: "App deletion committed, but cleanup did not finish",
      details: { retryAfterMs: 1000 },
    },
    partialDelete: {
      removed: [{ childType: "experiments", id: "exp_1" }],
      appliedApprovalRequestIds: ["apr_1"],
    },
  } as const;

  it("completes deletion and resyncs when read-back proves the App is gone", async () => {
    const resume = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: { deleted: true as const },
    }));
    const resync = vi.fn(async () => {});

    const settled = await settleAppDelete(
      partial,
      async () => ({
        ok: false,
        status: 404,
        error: { code: "APP_NOT_FOUND", message: "App not found", details: {} },
      }),
      resume,
      resync,
    );

    expect(settled).toEqual({
      ok: true,
      status: 200,
      data: {
        deleted: true,
      },
      sessionResync: { ok: true },
    });
    expect(resume).toHaveBeenCalledOnce();
    expect(resync).toHaveBeenCalledOnce();
  });

  it("keeps cleanup retryable when the App is gone but finalize still fails", async () => {
    const resumedFailure = {
      ok: false,
      status: 503,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Exposure status cleanup is unavailable",
        details: { retryAfterMs: 30_000 },
      },
    } as const;
    const resync = vi.fn(async () => {});

    const settled = await settleAppDelete(
      partial,
      async () => ({
        ok: false,
        status: 404,
        error: { code: "APP_NOT_FOUND", message: "App not found", details: {} },
      }),
      async () => resumedFailure,
      resync,
    );

    expect(settled).toEqual({
      ...resumedFailure,
      partialDelete: partial.partialDelete,
      appDeleted: true,
    });
    expect(resync).not.toHaveBeenCalled();
  });

  it("keeps the partial result when read-back cannot determine existence", async () => {
    const resume = vi.fn();
    const resync = vi.fn(async () => {});

    const settled = await settleAppDelete(
      partial,
      async () => {
        throw new TypeError("response was lost");
      },
      resume,
      resync,
    );

    expect(settled).toBe(partial);
    expect(resume).not.toHaveBeenCalled();
    expect(resync).not.toHaveBeenCalled();
  });

  it("keeps the partial result when read-back confirms the App still exists", async () => {
    const resume = vi.fn();
    const resync = vi.fn(async () => {});

    const settled = await settleAppDelete(
      partial,
      async () => ({ ok: true, status: 200, data: { app: { id: "app_1" } } }),
      resume,
      resync,
    );

    expect(settled).toBe(partial);
    expect(resume).not.toHaveBeenCalled();
    expect(resync).not.toHaveBeenCalled();
  });
});
