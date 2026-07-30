import { describe, expect, it } from "vitest";
import {
  type CreateControlPanelAppResult,
  createAppEffect,
  settleAfterCreate,
} from "./create-app-outcome";

type Refusal = Extract<CreateControlPanelAppResult, { outcome: "refused" }>;

function refused(status: number, error: Refusal["error"]): CreateControlPanelAppResult {
  return { outcome: "refused", status, error };
}

describe("settleAfterCreate", () => {
  // SPL-203: the App is already created in the Control Plane by the time this
  // runs. A throwing resync (missing workosSessionId, a buildSessionPrincipal
  // invariant break, refreshSession's expired-TTL guard) must not be reported
  // as a create failure — that told the operator to retry a mutation that
  // already succeeded, which then collided with the App key it took
  // (`apps_org_key_unique`).
  it("reports success with the stale-session signal when create succeeds and resync throws", async () => {
    const resync = () =>
      Promise.reject(new Error("control-panel session is missing its WorkOS session identifier"));

    const result = await settleAfterCreate("checkout-api", resync);

    expect(result).toEqual({
      outcome: "created-session-stale",
      appSlug: "checkout-api",
      reason: "control-panel session is missing its WorkOS session identifier",
    });
  });

  it("reports plain success when create succeeds and resync also succeeds", async () => {
    const result = await settleAfterCreate("checkout-api", () => Promise.resolve());

    expect(result).toEqual({ outcome: "created", appSlug: "checkout-api" });
  });

  it("stringifies a non-Error resync throw rather than losing the reason", async () => {
    const resync = () => Promise.reject("session store unavailable");

    const result = await settleAfterCreate("checkout-api", resync);

    expect(result).toEqual({
      outcome: "created-session-stale",
      appSlug: "checkout-api",
      reason: "session store unavailable",
    });
  });
});

describe("Create App effect", () => {
  it("treats a created App as created", () => {
    expect(createAppEffect({ outcome: "created", appSlug: "checkout-api" })).toEqual({
      kind: "created",
      appSlug: "checkout-api",
    });
  });

  // The load-bearing assertion for SPL-203: every outcome `settleAfterCreate`
  // can produce from an ok create — including the stale-session one — must
  // route away from the "failed" branch that renders "The Control Plane could
  // not create this App. Try again." That copy is unreachable from here.
  it("treats a created App with a failed session resync as created, not failed", async () => {
    const settled = await settleAfterCreate("checkout-api", () =>
      Promise.reject(new Error("refreshSession: session already expired")),
    );

    const effect = createAppEffect(settled);

    expect(effect).toEqual({ kind: "session-stale", appSlug: "checkout-api" });
  });

  it("proves the create-failure branch is unreachable for every outcome of an ok create", async () => {
    const outcomes = await Promise.all([
      settleAfterCreate("app-a", () => Promise.resolve()),
      settleAfterCreate("app-b", () => Promise.reject(new Error("boom"))),
    ]);

    for (const outcome of outcomes) {
      expect(createAppEffect(outcome).kind).not.toBe("failed");
    }
  });

  it("treats a refusal as failed", () => {
    const effect = createAppEffect(
      refused(500, {
        code: "INTERNAL_SERVER_ERROR",
        message: "identity store unavailable",
        details: {},
      }),
    );

    expect(effect.kind).toBe("failed");
  });

  it("falls back to the create-failure copy only for an unrecognised or thrown shape", () => {
    expect(createAppEffect(new Error("network unavailable"))).toEqual({
      kind: "failed",
      failure: {
        kind: "form",
        message: "The Control Plane could not create this App. Try again.",
        fields: [],
      },
    });
    expect(createAppEffect(undefined).kind).toBe("failed");
  });

  it("treats an unrecognised shape as failed rather than as a silent success", () => {
    expect(createAppEffect({ outcome: "created" }).kind).toBe("failed");
  });
});
