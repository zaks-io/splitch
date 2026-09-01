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

  it("completes deletion and resyncs when the retry resumes the saga", async () => {
    const resume = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: { deleted: true as const },
    }));
    const resync = vi.fn(async () => {});

    const settled = await settleAppDelete(partial, resume, resync);

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

  it("keeps cleanup retryable when the resumed response proves the App is gone", async () => {
    const resumedFailure = {
      ok: false,
      status: 503,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Exposure status cleanup is unavailable",
        details: { retryAfterMs: 30_000, mutationCommitted: true },
      },
    } as const;
    const resync = vi.fn(async () => {});

    const settled = await settleAppDelete(partial, async () => resumedFailure, resync);

    expect(settled).toEqual({
      ...resumedFailure,
      partialDelete: partial.partialDelete,
      appDeleted: true,
      sessionResync: { ok: true },
    });
    expect(resync).toHaveBeenCalledOnce();
  });

  it("marks deletion indeterminate when the retry response is lost", async () => {
    const resume = vi.fn(async () => {
      throw new TypeError("response was lost");
    });
    const resync = vi.fn(async () => {});

    const settled = await settleAppDelete(partial, resume, resync);

    expect(settled).toEqual({ ...partial, deleteIndeterminate: true });
    expect(resume).toHaveBeenCalledOnce();
    expect(resync).not.toHaveBeenCalled();
  });

  it("keeps a committed cleanup failure actionable without partial progress", async () => {
    const committed = {
      ok: false,
      status: 503,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Exposure status cleanup is unavailable",
        details: { retryAfterMs: 30_000, mutationCommitted: true },
      },
    } as const;
    const resume = vi.fn(async () => {
      throw new TypeError("response was lost");
    });

    const resync = vi.fn(async () => {});

    await expect(settleAppDelete(committed, resume, resync)).resolves.toEqual({
      ...committed,
      appDeleted: true,
      sessionResync: { ok: true },
    });
    expect(resync).toHaveBeenCalledOnce();
  });

  it("reports a stale session without pretending committed cleanup finished", async () => {
    const committed = {
      ok: false,
      status: 503,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Exposure status cleanup is unavailable",
        details: { retryAfterMs: 30_000, mutationCommitted: true },
      },
    } as const;

    await expect(
      settleAppDelete(
        committed,
        async () => committed,
        async () => {
          throw new Error("session store unavailable");
        },
      ),
    ).resolves.toEqual({
      ...committed,
      appDeleted: true,
      sessionResync: {
        ok: false,
        reason: "session store unavailable",
        remedy: "retry",
      },
    });
  });

  it("does not retry an uncommitted cleanup failure without partial progress", async () => {
    const uncommitted = {
      ok: false,
      status: 503,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Holdover write outbox cleanup is unavailable",
        details: { retryAfterMs: 30_000 },
      },
    } as const;
    const resume = vi.fn();

    await expect(settleAppDelete(uncommitted, resume, async () => {})).resolves.toBe(uncommitted);
    expect(resume).not.toHaveBeenCalled();
  });

  it("does not retry a repeated Approval Request invariant", async () => {
    const invariant = {
      ...partial,
      error: {
        ...partial.error,
        code: "INTERNAL_SERVER_ERROR",
        details: { fault: "panel_app_delete_repeated_approval" },
      },
    } as const;
    const resume = vi.fn();
    const resync = vi.fn(async () => {});

    const settled = await settleAppDelete(invariant, resume, resync);

    expect(settled).toBe(invariant);
    expect(resume).not.toHaveBeenCalled();
    expect(resync).not.toHaveBeenCalled();
  });
});
