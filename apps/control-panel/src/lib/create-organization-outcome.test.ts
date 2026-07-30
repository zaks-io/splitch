import { describe, expect, it } from "vitest";
import {
  type CreateControlPanelOrganizationResult,
  createOrganizationEffect,
  createOrganizationFailure,
} from "./create-organization-outcome";

type Refusal = Extract<CreateControlPanelOrganizationResult, { outcome: "refused" }>;

function refused(status: number, error: Refusal["error"]): CreateControlPanelOrganizationResult {
  return { outcome: "refused", status, error };
}

describe("Create Organization failure surface", () => {
  it("shows the Worker's taken-handle refusal verbatim and points at the handle field", () => {
    const failure = createOrganizationFailure(
      refused(409, {
        code: "SLUG_CONFLICT",
        message: 'URL handle "atlas-works" is already taken',
        details: {
          resourceType: "organization",
          conflictingSlug: "atlas-works",
          recommendedAction: "CHOOSE_DIFFERENT_SLUG",
        },
      }),
    );

    expect(failure.message).toBe('URL handle "atlas-works" is already taken');
    expect(failure.slugMessage).toBe('URL handle "atlas-works" is already taken');
    // The action that can actually succeed: a different handle, not a retry of
    // the same one (ADR-0036).
    expect(failure.nextStep).toContain("Pick a different one");
  });

  it("tells an expired session to sign in rather than to try again", () => {
    const failure = createOrganizationFailure(
      refused(401, { code: "UNAUTHORIZED", message: "authentication required", details: {} }),
    );

    expect(failure.title).toBe("Your session has ended");
    expect(failure.nextStep).toContain("Sign in again");
  });

  it("offers no next step when the Worker says the principal may not create at all", () => {
    const failure = createOrganizationFailure(
      refused(403, {
        code: "FORBIDDEN",
        message:
          "a provisional (anonymous) principal cannot create Organizations; complete the claim ceremony at POST /api/auth/claim/start to obtain an identified principal first",
        details: {},
      }),
    );

    // A retry cannot work from here, so none is offered; the Worker's own words
    // already name the ceremony that can.
    expect(failure.nextStep).toBeNull();
    expect(failure.message).toContain("claim ceremony");
  });

  it("routes a validation issue on the handle onto the handle field", () => {
    const failure = createOrganizationFailure(
      refused(400, {
        code: "VALIDATION_ERROR",
        message: "The Organization draft is malformed",
        details: { issues: [{ path: ["slug"], message: "slug is reserved" }] },
      }),
    );

    expect(failure.slugMessage).toBe("slug is reserved");
    expect(failure.nextStep).toContain("Correct the highlighted field");
  });

  it("states that nothing was created when the Control Plane could not be reached", () => {
    const failure = createOrganizationFailure(new Error("binding unavailable"));

    expect(failure.message).toContain("nothing was created");
    expect(failure.nextStep).toContain("create again");
    expect(failure.slugMessage).toBeUndefined();
  });

  it("still surfaces an unexpected Worker refusal in the Worker's words", () => {
    const failure = createOrganizationFailure(
      refused(500, {
        code: "INTERNAL_SERVER_ERROR",
        message: "identity store unavailable",
        details: {},
      }),
    );

    expect(failure.message).toBe("identity store unavailable");
  });
});

describe("Create Organization effect", () => {
  it("treats a created Organization as created", () => {
    expect(createOrganizationEffect({ outcome: "created", orgSlug: "kiln-works" })).toEqual({
      kind: "created",
      orgSlug: "kiln-works",
    });
  });

  // SPL-203: the sibling App path folds a failed session resync into "could not
  // create", which tells the user to retry a mutation that already succeeded.
  it("treats a created Organization with a failed session resync as created, not failed", () => {
    const effect = createOrganizationEffect({
      outcome: "created-session-stale",
      orgSlug: "kiln-works-eu",
      reason: "control-panel session is missing its WorkOS session identifier",
    });

    expect(effect).toEqual({ kind: "session-stale", orgSlug: "kiln-works-eu" });
  });

  it("treats a refusal as failed", () => {
    const effect = createOrganizationEffect(
      refused(409, {
        code: "SLUG_CONFLICT",
        message: 'URL handle "kiln-works" is already taken',
        details: {
          resourceType: "organization",
          conflictingSlug: "kiln-works",
          recommendedAction: "CHOOSE_DIFFERENT_SLUG",
        },
      }),
    );

    expect(effect.kind).toBe("failed");
  });

  it("treats an unrecognised shape as failed rather than as a silent success", () => {
    expect(createOrganizationEffect({ outcome: "created" }).kind).toBe("failed");
    expect(createOrganizationEffect(undefined).kind).toBe("failed");
  });
});
