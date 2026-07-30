import { describe, expect, it } from "vitest";
import {
  authorizesLiveUpdateConnection,
  type LiveUpdateConnectionContext,
} from "./live-update-connection";

/**
 * The stored session is written by the Control Panel and re-read here, so this
 * schema is a second reader of someone else's shape. `.strict()` makes that
 * coupling load-bearing: a field the Control Panel adds and this schema has not
 * been taught refuses the whole session, and every live-update socket dies with
 * no signal beyond "not authorized". `orgsTruncated` did exactly that.
 */

const EXPIRES_AT = 2_000_000_000;

const context: LiveUpdateConnectionContext = {
  version: 1,
  sessionTokenHash: "a".repeat(64),
  userId: "user_1",
  orgId: "org_1",
  appId: "app_1",
  environmentId: "env_1",
  expiresAt: EXPIRES_AT,
};

function session(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2,
    userId: "user_1",
    expiresAt: EXPIRES_AT,
    orgs: [
      {
        orgId: "org_1",
        orgSlug: "org-one",
        orgRole: "owner",
        isProvisional: false,
        demoExpiresAt: null,
        apps: [{ appId: "app_1", appSlug: "app-one", role: "owner" }],
      },
    ],
    ...extra,
  });
}

describe("live-update connection authorization", () => {
  it("authorizes a session that reports a truncated Organization list", () => {
    expect(authorizesLiveUpdateConnection(session({ orgsTruncated: true }), context, 0)).toBe(true);
    expect(authorizesLiveUpdateConnection(session({ orgsTruncated: false }), context, 0)).toBe(
      true,
    );
  });

  it("still refuses a session carrying a field nobody modelled", () => {
    expect(authorizesLiveUpdateConnection(session({ impersonate: "user_2" }), context, 0)).toBe(
      false,
    );
  });

  it("refuses when the App is not in the Organizations the session carries", () => {
    expect(
      authorizesLiveUpdateConnection(
        session({ orgsTruncated: true }),
        { ...context, appId: "app_2" },
        0,
      ),
    ).toBe(false);
  });
});
