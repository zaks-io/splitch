import { authorizesLiveUpdateConnection } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { APP_MEMBERSHIP_KEYS, ORG_MEMBERSHIP_KEYS, STORED_SESSION_KEYS } from "./session-schema";

/**
 * The stored session is written here and re-read by `LiveUpdateSessionSchema` in
 * `@splitch/contracts`, which the config-store Durable Object uses to authorize
 * live-update sockets. That schema is `.strict()`, so a field added to the
 * session here and not modelled there does not degrade the socket, it REFUSES
 * every session, for every User, with no signal past "not authorized".
 *
 * That is not hypothetical. `orgsTruncated` was the first field added to the
 * session since the contract schema existed, and it broke on the first try.
 *
 * So the fixture below is checked against the key sets rather than hand-written
 * to match them: adding a session key without teaching this test about it fails
 * here, and teaching this test about it without teaching the contract schema
 * fails at the assertion. Both failures name the drift.
 */

const EXPIRES_AT = 2_000_000_000;

const MAXIMAL_APP_MEMBERSHIP = {
  appId: "app_1",
  appSlug: "app-one",
  role: "owner",
};

const MAXIMAL_ORG_MEMBERSHIP = {
  orgId: "org_1",
  orgSlug: "org-one",
  orgRole: "owner",
  isProvisional: true,
  demoExpiresAt: "2099-01-01T00:00:00.000Z",
  apps: [MAXIMAL_APP_MEMBERSHIP],
};

/** Every key the Control Panel will ever write, all populated. */
const MAXIMAL_STORED_SESSION = {
  userId: "user_1",
  orgs: [MAXIMAL_ORG_MEMBERSHIP],
  orgsTruncated: true,
  expiresAt: EXPIRES_AT,
  workosSessionId: "session_1",
  workosAccessToken: "token_1",
  workosRefreshToken: "refresh_1",
  workosAccessTokenExpiresAt: EXPIRES_AT - 300,
  version: 2,
};

const context = {
  version: 1,
  sessionTokenHash: "a".repeat(64),
  userId: "user_1",
  orgId: "org_1",
  appId: "app_1",
  environmentId: "env_1",
} as const;

function missingFrom(keys: Set<string>, fixture: object): Array<string> {
  return [...keys].filter((key) => !Object.hasOwn(fixture, key));
}

describe("stored session against the live-update contract schema", () => {
  it("populates every key the session validator allows", () => {
    expect(missingFrom(STORED_SESSION_KEYS, MAXIMAL_STORED_SESSION)).toEqual([]);
    expect(missingFrom(ORG_MEMBERSHIP_KEYS, MAXIMAL_ORG_MEMBERSHIP)).toEqual([]);
    expect(missingFrom(APP_MEMBERSHIP_KEYS, MAXIMAL_APP_MEMBERSHIP)).toEqual([]);
  });

  it("authorizes a maximal session, so no Panel session field is unmodelled in the contract schema", () => {
    const authorized = authorizesLiveUpdateConnection(
      JSON.stringify(MAXIMAL_STORED_SESSION),
      { ...context, expiresAt: EXPIRES_AT },
      0,
    );

    expect(
      authorized,
      "A Control Panel session field is not modelled in LiveUpdateSessionSchema " +
        "(packages/contracts/src/live-update-connection.ts). That schema is .strict(), " +
        "so it now refuses EVERY session and every live-update socket is dead. " +
        "Add the field to the schema; do not relax .strict().",
    ).toBe(true);
  });
});
